/**
 * PostgreSQL store of private questions (#467, migration 151).
 *
 * Exports:
 * - `PrivateQuestionRow`, `PrivateQuestionState`: one question and where it stands.
 * - `PrivateQuestionStore`: what intake, the turn and retention need; `privateQuestionStore` is production.
 *
 * Key constructs:
 * - A webhook redelivery finds the row by `update_id` and changes nothing.
 * - Decisions about one question are taken under its row lock, so the webhook's arrival step and the
 *   queue's processing never both send a reply.
 * - A question and its answer live a day (`PRIVATE_QUESTION_RETENTION_MS`); erasing also blanks the
 *   question's text in the raw ingress copy, whose row stays for queue bookkeeping.
 */
import type { PoolClient } from "pg";

import { PRIVATE_QUESTION_RETENTION_MS } from "../../config.js";
import { database } from "../database.js";

export type PrivateQuestionState =
  | "answered" | "answering" | "cancelled" | "failed" | "placeholder_sent" | "received" | "refused" | "window_missed";

export interface PrivateQuestionRow {
  readonly answer: string | null;
  readonly groupId: string;
  readonly id: string;
  readonly incomingEphemeralMessageId: number;
  readonly placeholderEphemeralMessageId: number | null;
  readonly question: string;
  readonly receivedAt: Date;
  readonly state: PrivateQuestionState;
  readonly telegramChatId: string;
  readonly telegramUserId: string;
  readonly threadId: number | null;
  readonly updateId: string;
}

export interface RecentPrivateExchange {
  readonly answer: string;
  readonly question: string;
  readonly receivedAt: Date;
}

/** Changes a locked question may receive; each sets the state and what goes with it. */
export type PrivateQuestionChange =
  | { readonly state: "placeholder_sent"; readonly placeholderEphemeralMessageId: number }
  | { readonly state: "answering" }
  | { readonly state: "answered"; readonly answer: string }
  | { readonly state: "cancelled" | "failed" | "refused" | "window_missed"; readonly code: string };

export interface PrivateQuestionStore {
  recordArrival(input: {
    readonly groupId: string;
    readonly incomingEphemeralMessageId: number;
    readonly question: string;
    readonly receivedAt: Date;
    readonly telegramChatId: string;
    readonly telegramUserId: string;
    readonly threadId: number | null;
    readonly updateId: string;
  }): Promise<void>;
  /** Runs `work` with the question locked; null when no question was recorded for the update. */
  withLocked<T>(updateId: string, work: (row: PrivateQuestionRow, change: (next: PrivateQuestionChange) => Promise<void>) => Promise<T>): Promise<T | null>;
  findById(id: string): Promise<PrivateQuestionRow | null>;
  findByUpdate(updateId: string): Promise<PrivateQuestionRow | null>;
  /** Answered questions of the same person, chat and topic, newest first. */
  recentExchanges(input: {
    readonly excludeId: string;
    readonly groupId: string;
    readonly limit: number;
    readonly since: Date;
    readonly telegramUserId: string;
    readonly threadId: number | null;
  }): Promise<RecentPrivateExchange[]>;
  /** Moves a question by id; used by the turn, which knows the question, not the update. */
  changeById(id: string, next: PrivateQuestionChange): Promise<void>;
  eraseExpired(now: Date): Promise<number>;
}

const COLUMNS = `id, group_id, telegram_chat_id, message_thread_id, telegram_user_id, update_id::text AS update_id,
  incoming_ephemeral_message_id, question, received_at, placeholder_ephemeral_message_id, state, answer`;

interface Row {
  answer: string | null; group_id: string; id: string; incoming_ephemeral_message_id: number;
  message_thread_id: number | null; placeholder_ephemeral_message_id: number | null; question: string;
  received_at: Date; state: PrivateQuestionState; telegram_chat_id: string; telegram_user_id: string; update_id: string;
}

function mapRow(row: Row): PrivateQuestionRow {
  return {
    answer: row.answer,
    groupId: row.group_id,
    id: row.id,
    incomingEphemeralMessageId: row.incoming_ephemeral_message_id,
    placeholderEphemeralMessageId: row.placeholder_ephemeral_message_id,
    question: row.question,
    receivedAt: row.received_at,
    state: row.state,
    telegramChatId: row.telegram_chat_id,
    telegramUserId: row.telegram_user_id,
    threadId: row.message_thread_id,
    updateId: row.update_id,
  };
}

async function applyChange(client: Pick<PoolClient, "query">, id: string, next: PrivateQuestionChange): Promise<void> {
  if (next.state === "placeholder_sent") {
    await client.query(
      `UPDATE telegram_private_questions SET state = 'placeholder_sent', placeholder_ephemeral_message_id = $2,
              placeholder_sent_at = now(), updated_at = now() WHERE id = $1`,
      [id, next.placeholderEphemeralMessageId],
    );
    return;
  }
  if (next.state === "answering") {
    await client.query("UPDATE telegram_private_questions SET state = 'answering', updated_at = now() WHERE id = $1", [id]);
    return;
  }
  if (next.state === "answered") {
    await client.query(
      "UPDATE telegram_private_questions SET state = 'answered', answer = $2, failure_code = NULL, updated_at = now() WHERE id = $1",
      [id, next.answer],
    );
    return;
  }
  await client.query(
    "UPDATE telegram_private_questions SET state = $2, failure_code = $3, updated_at = now() WHERE id = $1",
    [id, next.state, next.code],
  );
}

export const privateQuestionStore: PrivateQuestionStore = {
  async recordArrival(input) {
    await database().query(
      `INSERT INTO telegram_private_questions
         (group_id, telegram_chat_id, message_thread_id, telegram_user_id, update_id, incoming_ephemeral_message_id,
          question, received_at, state, erase_after)
       VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8, 'received', $8::timestamptz + $9 * interval '1 millisecond')
       ON CONFLICT (update_id) DO NOTHING`,
      [input.groupId, input.telegramChatId, input.threadId, input.telegramUserId, input.updateId,
        input.incomingEphemeralMessageId, input.question, input.receivedAt, PRIVATE_QUESTION_RETENTION_MS],
    );
  },

  async withLocked(updateId, work) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Row>(
        `SELECT ${COLUMNS} FROM telegram_private_questions WHERE update_id = $1::bigint FOR UPDATE`,
        [updateId],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      const value = await work(mapRow(row), (next) => applyChange(client, row.id, next));
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async findById(id) {
    const result = await database().query<Row>(`SELECT ${COLUMNS} FROM telegram_private_questions WHERE id = $1`, [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  },

  async findByUpdate(updateId) {
    const result = await database().query<Row>(
      `SELECT ${COLUMNS} FROM telegram_private_questions WHERE update_id = $1::bigint`, [updateId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  },

  async recentExchanges(input) {
    const result = await database().query<{ answer: string; question: string; received_at: Date }>(
      `SELECT question, answer, received_at FROM telegram_private_questions
        WHERE group_id = $1 AND telegram_user_id = $2 AND message_thread_id IS NOT DISTINCT FROM $3
          AND state = 'answered' AND answer IS NOT NULL AND received_at >= $4 AND id <> $5
        ORDER BY received_at DESC LIMIT $6`,
      [input.groupId, input.telegramUserId, input.threadId, input.since, input.excludeId, input.limit],
    );
    return result.rows.map((row) => ({ answer: row.answer, question: row.question, receivedAt: row.received_at }));
  },

  async changeById(id, next) {
    await applyChange(database(), id, next);
  },

  async eraseExpired(now) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const erased = await client.query<{ update_id: string }>(
        "DELETE FROM telegram_private_questions WHERE erase_after < $1 RETURNING update_id::text AS update_id",
        [now],
      );
      const ids = erased.rows.map((row) => row.update_id);
      if (ids.length > 0) {
        // The raw copy keeps its row for the queue's bookkeeping; only the person's words go.
        await client.query(
          `UPDATE telegram_ingress_updates
              SET payload = jsonb_set(payload, '{message,text}', to_jsonb('[стёрто]'::text), false)
            WHERE update_id = ANY($1::bigint[]) AND payload ? 'message'`,
          [ids],
        );
      }
      await client.query("COMMIT");
      return ids.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
