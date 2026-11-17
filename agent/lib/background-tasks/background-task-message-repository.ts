/**
 * Corrections and answers the main agent sends a background task (#519).
 *
 * Export:
 * - `backgroundTaskMessageRepository`: adds a message, hands waiting ones to one tool call of the task,
 *   releases a failed call's claim, records delivery, and hands the rest to the input of a new turn.
 *
 * Key constructs:
 * - A message is shown once. A tool call claims it under the pair (turn, call), since a call id is
 *   unique only within its turn; a retry of the same call sees the same messages, a parallel call of the
 *   same step sees none of them, and a claim of a turn that ended undelivered is free again.
 * - It counts as delivered when the next model step of that turn starts: only then had the model the
 *   result in its prompt. A new turn takes everything still undelivered into its input instead.
 * - A message to a waiting task puts it back in the queue in the same transaction.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import { BACKGROUND_TASK_ACTIVE_STATES, inTransaction } from "./background-task-records.js";

export interface BackgroundTaskMessage {
  readonly id: string;
  readonly text: string;
}

export interface BackgroundTaskCall {
  readonly callId: string;
  readonly turnId: string;
}

// Turn input claims carry this call id: no tool call has it, so no tool call releases them.
const TURN_INPUT_CALL_ID = "turn-input";

export const backgroundTaskMessageRepository = {
  /**
   * Adds a correction or an answer. A waiting task goes back to the queue with it; a repeat of the same
   * tool call adds nothing. Returns null for a task that already ended or is being stopped.
   */
  async append(input: {
    readonly authorUserId: string;
    readonly createdByCallId: string;
    readonly createdByTurnId: string;
    readonly now: Date;
    readonly taskId: string;
    readonly text: string;
  }): Promise<"next_step" | "resumes" | null> {
    return await inTransaction(async (client) => {
      const current = await client.query<{ state: string }>(
        "SELECT state FROM background_tasks WHERE id = $1 FOR UPDATE", [input.taskId],
      );
      const state = current.rows[0]?.state;
      // A stopping task only writes its summary: a correction would never reach it.
      if (state === undefined || state === "stopping" || !(BACKGROUND_TASK_ACTIVE_STATES as readonly string[]).includes(state)) return null;
      await client.query(
        `INSERT INTO background_task_messages (task_id, author_user_id, text, created_by_turn_id, created_by_call_id)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (created_by_turn_id, created_by_call_id) DO NOTHING`,
        [input.taskId, input.authorUserId, input.text, input.createdByTurnId, input.createdByCallId],
      );
      if (state !== "waiting_answer") return "next_step";
      await client.query(
        `UPDATE background_tasks SET state = 'queued', waiting_question = NULL, waiting_since = NULL, queued_at = $2, updated_at = $2
          WHERE id = $1`,
        [input.taskId, input.now],
      );
      return "resumes";
    });
  },

  /** Undelivered messages for this call, oldest first; a retry of the call sees the same ones. */
  async claimForCall(taskId: string, call: BackgroundTaskCall): Promise<BackgroundTaskMessage[]> {
    const result = await database().query<BackgroundTaskMessage>(
      `UPDATE background_task_messages SET claimed_by_turn_id = $2, claimed_by_call_id = $3
        WHERE task_id = $1 AND delivered_at IS NULL
          AND (claimed_by_turn_id IS NULL OR claimed_by_turn_id <> $2 OR claimed_by_call_id = $3)
        RETURNING id::text, text`,
      [taskId, call.turnId, call.callId],
    );
    return result.rows.sort((left, right) => Number(left.id) - Number(right.id));
  },

  /** Frees what an attempt of this call claimed, so its failed result does not count as seen. */
  async releaseCall(taskId: string, call: BackgroundTaskCall): Promise<void> {
    await database().query(
      `UPDATE background_task_messages SET claimed_by_turn_id = NULL, claimed_by_call_id = NULL
        WHERE task_id = $1 AND delivered_at IS NULL AND claimed_by_turn_id = $2 AND claimed_by_call_id = $3`,
      [taskId, call.turnId, call.callId],
    );
  },

  /** A model step of the turn started: every claim of its earlier calls reached the prompt. */
  async markDelivered(taskId: string, turnId: string, now: Date): Promise<number> {
    const result = await database().query(
      `UPDATE background_task_messages SET delivered_at = $3
        WHERE task_id = $1 AND claimed_by_turn_id = $2 AND delivered_at IS NULL`,
      [taskId, turnId, now],
    );
    return result.rowCount ?? 0;
  },

  async hasUndelivered(taskId: string): Promise<boolean> {
    const result = await database().query(
      "SELECT 1 FROM background_task_messages WHERE task_id = $1 AND delivered_at IS NULL LIMIT 1", [taskId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /** Inside the transaction that creates a turn: everything undelivered, locked until the turn takes it. */
  async lockUndelivered(client: Pick<PoolClient, "query">, taskId: string): Promise<BackgroundTaskMessage[]> {
    const result = await client.query<BackgroundTaskMessage>(
      `SELECT id::text, text FROM background_task_messages
        WHERE task_id = $1 AND delivered_at IS NULL ORDER BY id FOR UPDATE`,
      [taskId],
    );
    return result.rows;
  },

  /** In the same transaction: the new turn's input carries these messages, so they are delivered. */
  async markTakenByTurn(client: Pick<PoolClient, "query">, ids: readonly string[], turnId: string, now: Date): Promise<void> {
    if (ids.length === 0) return;
    await client.query(
      `UPDATE background_task_messages SET claimed_by_turn_id = $2, claimed_by_call_id = $3, delivered_at = $4
        WHERE id = ANY($1::bigint[])`,
      [ids, turnId, TURN_INPUT_CALL_ID, now],
    );
  },
};
