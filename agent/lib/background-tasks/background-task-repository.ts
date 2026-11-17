/**
 * PostgreSQL lifecycle of background tasks (#519).
 *
 * Export:
 * - `backgroundTaskRepository`: every state change of a task, each one statement or one transaction.
 * - `BackgroundTaskOutcome`: how a task ended, as its dispatcher records it.
 *
 * Key constructs:
 * - At most `limit` tasks run at once: a claim counts the running ones under an advisory lock, so two
 *   dispatch passes never start one too many.
 * - The clock runs only while a task's turn runs: `active_ms` takes the time since `running_since` at
 *   every step and when the task stops running, and a restart starts `running_since` again.
 * - Every end of a task writes its outcome event and retires its session in the same transaction: no
 *   task ends without an event, and its journal is deleted with the other retired sessions.
 * - A task is found only within its own chat and topic: another chat sees no such task.
 */
import type { PoolClient } from "pg";

import { SESSION_RETENTION_DAYS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  BACKGROUND_TASK_ACTIVE_STATES,
  type BackgroundTask,
  type BackgroundTaskChat,
  type BackgroundTaskOutcomeState,
  type BackgroundTaskSummaryReason,
  inTransaction,
  mapTask,
  type TaskRow,
} from "./background-task-records.js";
import { BACKGROUND_TASK_RETENTION_DAYS } from "./background-task-config.js";

// Serializes the claim of a free place across processes and dispatch passes.
const CLAIM_LOCK_KEY = 519_001;
// The working time a statement adds: from the start of the run under way to $2.
const RUN_SO_FAR = "CASE WHEN running_since IS NULL THEN 0 ELSE GREATEST(0, (extract(epoch FROM ($2::timestamptz - running_since)) * 1000)::bigint) END";

export interface BackgroundTaskOutcome {
  readonly code: string;
  readonly files?: readonly string[];
  readonly id: string;
  readonly now: Date;
  readonly state: BackgroundTaskOutcomeState;
  readonly text: string | null;
}

// The event is due at the moment of the transition, on the same clock its claim compares with.
async function enqueueEvent(
  client: Pick<PoolClient, "query">,
  event: { readonly kind: "outcome" | "question"; readonly now: Date; readonly questionSeq: number; readonly taskId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO background_task_events (task_id, kind, question_seq, available_at, created_at) VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (task_id, kind, question_seq) DO NOTHING`,
    [event.taskId, event.kind, event.questionSeq, event.now],
  );
}

/** Locks the task row (as a new message does) and says whether a message still waits for the task. */
async function lockWithPendingMessages(client: Pick<PoolClient, "query">, id: string): Promise<boolean> {
  await client.query("SELECT 1 FROM background_tasks WHERE id = $1 FOR UPDATE", [id]);
  const pending = await client.query(
    "SELECT 1 FROM background_task_messages WHERE task_id = $1 AND delivered_at IS NULL LIMIT 1", [id],
  );
  return (pending.rowCount ?? 0) > 0;
}

async function retireSession(client: Pick<PoolClient, "query">, applicationSessionId: string | null, now: Date): Promise<void> {
  if (applicationSessionId === null) return;
  await client.query(
    `UPDATE conversation_sessions
        SET retired_at = $2, task_state = 'completed', delete_after = $2::timestamptz + $3 * interval '1 day'
      WHERE id = $1 AND kind = 'background' AND retired_at IS NULL`,
    [applicationSessionId, now, SESSION_RETENTION_DAYS],
  );
}

/** Ends an active task and writes its outcome event; the clock takes the run under way. */
async function finishInTransaction(client: PoolClient, input: BackgroundTaskOutcome): Promise<BackgroundTask | null> {
  const result = await client.query<TaskRow>(
    `UPDATE background_tasks
        SET state = $3, outcome_code = $4, outcome_text = $5, outcome_files = $6::jsonb, finished_at = $2,
            active_ms = active_ms + ${RUN_SO_FAR},
            running_since = NULL, waiting_question = NULL, waiting_since = NULL, current_turn_id = NULL, updated_at = $2
      WHERE id = $1 AND state = ANY($7::text[])
      RETURNING *`,
    [input.id, input.now, input.state, input.code, input.text, JSON.stringify(input.files ?? []), BACKGROUND_TASK_ACTIVE_STATES],
  );
  const row = result.rows[0];
  if (!row) return null;
  await enqueueEvent(client, { kind: "outcome", now: input.now, questionSeq: 0, taskId: row.id });
  await retireSession(client, row.application_session_id, input.now);
  return mapTask(row);
}

export const backgroundTaskRepository = {
  /** A repeat of the same tool call returns the task it created. */
  async create(input: {
    readonly authorUserId: string;
    readonly createdByCallId: string;
    readonly createdByTurnId: string;
    readonly familyId: string;
    readonly forumTopicId: string | null;
    readonly groupId: string | null;
    readonly ingressQueueId: string | null;
    readonly messageThreadId: string | null;
    readonly sandboxSessionId: string;
    readonly task: string;
    readonly telegramChatId: string;
    readonly telegramChatType: BackgroundTask["telegramChatType"];
    readonly title: string;
  }): Promise<{ readonly created: boolean; readonly task: BackgroundTask }> {
    const inserted = await database().query<TaskRow>(
      `INSERT INTO background_tasks (family_id, group_id, telegram_chat_id, telegram_chat_type, forum_topic_id,
          message_thread_id, sandbox_session_id, ingress_queue_id, author_user_id, title, task, state, created_by_turn_id,
          created_by_call_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12, $13)
       ON CONFLICT (created_by_turn_id, created_by_call_id) DO NOTHING
       RETURNING *`,
      [input.familyId, input.groupId, input.telegramChatId, input.telegramChatType, input.forumTopicId,
        input.messageThreadId, input.sandboxSessionId, input.ingressQueueId, input.authorUserId, input.title, input.task,
        input.createdByTurnId, input.createdByCallId],
    );
    if (inserted.rows[0]) return { created: true, task: mapTask(inserted.rows[0]) };
    const existing = await database().query<TaskRow>(
      "SELECT * FROM background_tasks WHERE created_by_turn_id = $1 AND created_by_call_id = $2",
      [input.createdByTurnId, input.createdByCallId],
    );
    // The conflicting row went between the two statements: only the 30-day erasure deletes one.
    if (!existing.rows[0]) throw new AppError("AGENT_BACKGROUND_TASK_CREATE_FAILED", "Не удалось записать фоновую задачу");
    return { created: false, task: mapTask(existing.rows[0]) };
  },

  async find(id: string): Promise<BackgroundTask | null> {
    const result = await database().query<TaskRow>("SELECT * FROM background_tasks WHERE id = $1", [id]);
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  },

  /** A task of this chat and topic, or null: a task of another chat does not exist here. */
  async findInChat(id: string, chat: BackgroundTaskChat): Promise<BackgroundTask | null> {
    if (!/^[1-9]\d{0,17}$/u.test(id)) return null;
    const result = await database().query<TaskRow>(
      `SELECT * FROM background_tasks
        WHERE id = $1 AND telegram_chat_id = $2 AND forum_topic_id IS NOT DISTINCT FROM $3`,
      [id, chat.telegramChatId, chat.forumTopicId],
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  },

  /** Active tasks of the chat and those created within the window, newest first. */
  async listInChat(chat: BackgroundTaskChat, since: Date, limit: number): Promise<BackgroundTask[]> {
    const result = await database().query<TaskRow>(
      `SELECT * FROM background_tasks
        WHERE telegram_chat_id = $1 AND forum_topic_id IS NOT DISTINCT FROM $2
          AND (state = ANY($3::text[]) OR created_at >= $4)
        ORDER BY id DESC LIMIT $5`,
      [chat.telegramChatId, chat.forumTopicId, BACKGROUND_TASK_ACTIVE_STATES, since, limit],
    );
    return result.rows.map(mapTask);
  },

  /** Starts the oldest queued task when fewer than `limit` run; null when no place or nothing waits. */
  async claimNextQueued(limit: number, now: Date): Promise<BackgroundTask | null> {
    return await inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_LOCK_KEY]);
      const running = await client.query<{ count: string }>(
        "SELECT count(*) FROM background_tasks WHERE state IN ('running', 'stopping')",
      );
      if (Number(running.rows[0]!.count) >= limit) return null;
      const result = await client.query<TaskRow>(
        `UPDATE background_tasks SET state = 'running', running_since = $1, updated_at = $1
          WHERE id = (SELECT id FROM background_tasks WHERE state = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`,
        [now],
      );
      return result.rows[0] ? mapTask(result.rows[0]) : null;
    });
  },

  /**
   * Running tasks no dispatcher of this process works on (after a restart, or after a deploy held their
   * next turn): their clock starts again now, so the time nobody worked on them is not counted.
   */
  async adoptRunning(now: Date, workingIds: readonly string[]): Promise<BackgroundTask[]> {
    const result = await database().query<TaskRow>(
      `UPDATE background_tasks SET running_since = $1, updated_at = $1
        WHERE state IN ('running', 'stopping') AND NOT (id = ANY($2::bigint[])) RETURNING *`,
      [now, workingIds],
    );
    return result.rows.map(mapTask);
  },

  /** The dispatcher lets a running task go for now: the work so far is counted, the clock waits for adoption. */
  async pauseClock(id: string, now: Date): Promise<void> {
    await database().query(
      `UPDATE background_tasks SET active_ms = active_ms + ${RUN_SO_FAR}, running_since = $2, updated_at = $2
        WHERE id = $1 AND state IN ('running', 'stopping')`,
      [id, now],
    );
  },

  /** Counts a model step and moves the clock forward; the task after the step, or null when it no longer runs. */
  async recordStep(id: string, now: Date): Promise<BackgroundTask | null> {
    const result = await database().query<TaskRow>(
      `UPDATE background_tasks
          SET steps = steps + 1, last_step_at = $2, updated_at = $2, active_ms = active_ms + ${RUN_SO_FAR}, running_since = $2
        WHERE id = $1 AND state IN ('running', 'stopping') RETURNING *`,
      [id, now],
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  },

  /** The task's latest words for the status, already cut to the column's length by the caller. */
  async recordNote(id: string, note: string): Promise<void> {
    await database().query(
      "UPDATE background_tasks SET note = $2, updated_at = now() WHERE id = $1 AND state IN ('running', 'stopping')",
      [id, note],
    );
  },

  /**
   * A queued or waiting task stops at once; a running one is marked and its dispatcher cuts its turn.
   * Returns the state after the request, or null for a task that already ended.
   */
  async requestStop(id: string, now: Date): Promise<"stopped" | "stopping" | null> {
    return await inTransaction(async (client) => {
      const current = await client.query<{ state: string }>("SELECT state FROM background_tasks WHERE id = $1 FOR UPDATE", [id]);
      const state = current.rows[0]?.state;
      if (state === "queued" || state === "waiting_answer") {
        await finishInTransaction(client, { code: "AGENT_BACKGROUND_TASK_STOPPED", id, now, state: "stopped", text: null });
        return "stopped";
      }
      if (state === "running" || state === "stopping") {
        await client.query(
          `UPDATE background_tasks SET state = 'stopping', stop_requested_at = COALESCE(stop_requested_at, $2), updated_at = $2
            WHERE id = $1`,
          [id, now],
        );
        return "stopping";
      }
      return null;
    });
  },

  /** Records the task's question; the task waits once its turn ended (`waitForAnswer`). The same question again is accepted. */
  async recordQuestion(id: string, question: string): Promise<boolean> {
    const result = await database().query(
      `UPDATE background_tasks SET waiting_question = $2, updated_at = now()
        WHERE id = $1 AND state = 'running' AND (waiting_question IS NULL OR waiting_question = $2)`,
      [id, question],
    );
    return result.rowCount === 1;
  },

  /**
   * The task's turn ended after its question: the place is freed, the clock stops, the chat is asked. A message
   * that came meanwhile (often the answer itself) is taken instead: the question is dropped and the task goes on.
   */
  async waitForAnswer(id: string, now: Date): Promise<BackgroundTask | "messages_pending" | null> {
    return await inTransaction(async (client) => {
      if (await lockWithPendingMessages(client, id)) {
        await client.query("UPDATE background_tasks SET waiting_question = NULL, updated_at = $2 WHERE id = $1", [id, now]);
        return "messages_pending";
      }
      const result = await client.query<TaskRow>(
        `UPDATE background_tasks
            SET state = 'waiting_answer', waiting_since = $2, question_seq = question_seq + 1, current_turn_id = NULL,
                active_ms = active_ms + ${RUN_SO_FAR}, running_since = NULL, updated_at = $2
          WHERE id = $1 AND state = 'running' AND waiting_question IS NOT NULL RETURNING *`,
        [id, now],
      );
      const row = result.rows[0];
      if (!row) return null;
      await enqueueEvent(client, { kind: "question", now, questionSeq: row.question_seq, taskId: row.id });
      return mapTask(row);
    });
  },

  /** Ends an active task with its outcome and the event that brings it to the chat. */
  async finish(input: BackgroundTaskOutcome): Promise<BackgroundTask | null> {
    return await inTransaction((client) => finishInTransaction(client, input));
  },

  /**
   * Ends the task unless a correction came after its turn ended: under the same row lock a new message
   * takes, so a correction is either seen by one more turn or refused as too late, never silently lost.
   */
  async finishUnlessMessages(input: BackgroundTaskOutcome): Promise<BackgroundTask | "messages_pending" | null> {
    return await inTransaction(async (client) => {
      if (await lockWithPendingMessages(client, input.id)) return "messages_pending";
      return await finishInTransaction(client, input);
    });
  },

  /** Records why the task is cut before its summary turn; the first reason stays. */
  async markSummary(id: string, reason: BackgroundTaskSummaryReason, now: Date): Promise<BackgroundTaskSummaryReason | null> {
    const result = await database().query<{ summary_reason: BackgroundTaskSummaryReason }>(
      `UPDATE background_tasks SET summary_reason = COALESCE(summary_reason, $2), updated_at = $3
        WHERE id = $1 AND state IN ('running', 'stopping') RETURNING summary_reason`,
      [id, reason, now],
    );
    return result.rows[0]?.summary_reason ?? null;
  },

  /** Tasks running, and queued before this one: fewer than the places means it starts within seconds. */
  async tasksAhead(id: string): Promise<number> {
    const result = await database().query<{ count: string }>(
      `SELECT count(*) FROM background_tasks
        WHERE state IN ('running', 'stopping') OR (state = 'queued' AND id < $1)`,
      [id],
    );
    return Number(result.rows[0]!.count);
  },

  /** Tasks that waited for an answer longer than `waitMs` end as unanswered. */
  async expireUnanswered(now: Date, waitMs: number): Promise<number> {
    const due = await database().query<{ id: string }>(
      "SELECT id FROM background_tasks WHERE state = 'waiting_answer' AND waiting_since <= $1",
      [new Date(now.getTime() - waitMs)],
    );
    let expired = 0;
    for (const { id } of due.rows) {
      const ended = await inTransaction(async (client) => {
        // Checked again under the row lock an answer takes: an answer that came meanwhile wins.
        const still = await client.query(
          "SELECT 1 FROM background_tasks WHERE id = $1 AND state = 'waiting_answer' AND waiting_since <= $2 FOR UPDATE",
          [id, new Date(now.getTime() - waitMs)],
        );
        if (still.rowCount !== 1) return null;
        return await finishInTransaction(client, { code: "AGENT_BACKGROUND_TASK_UNANSWERED", id, now, state: "unanswered", text: null });
      });
      if (ended) expired += 1;
    }
    return expired;
  },

  /**
   * Erases ended tasks older than the retention, in bounded portions; messages and events go with them.
   * A task still at work is never erased under its dispatcher.
   */
  async purgeOld(now: Date, batchSize: number): Promise<number> {
    const result = await database().query(
      `DELETE FROM background_tasks WHERE id IN (
         SELECT id FROM background_tasks
          WHERE created_at < $1::timestamptz - $2 * interval '1 day' AND NOT (state = ANY($4::text[]))
          ORDER BY id LIMIT $3)`,
      [now, BACKGROUND_TASK_RETENTION_DAYS, batchSize, BACKGROUND_TASK_ACTIVE_STATES],
    );
    return result.rowCount ?? 0;
  },
};
