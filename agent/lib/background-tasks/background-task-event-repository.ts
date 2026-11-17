/**
 * The queue that brings a background task's question and outcome to its chat (#519).
 *
 * Export:
 * - `BackgroundTaskEvent`: a leased event and its task.
 * - `backgroundTaskEventRepository`: claim, bind the answering turn, answer, retry or give up.
 *
 * Key constructs:
 * - Unlike the wake-up queue, an event is repeated until a turn of the main agent answered it: it is
 *   answered only after that turn ended well, and a failure brings it back after a pause, a bounded
 *   number of times. An outcome answered makes its task reported.
 * - An event is claimed only when its chat's lane holds no waiting or running Telegram update and no
 *   wake-up: it waits behind the person's messages instead of overtaking them.
 * - A lease that expired (the process died while answering) makes the event due again.
 * - Like a wake-up, a new event is taken only while the application is `ready`: a deploy waits for an
 *   event being answered (`runtime_is_idle`) and starts none; one whose turn exists may still finish.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import { inTransaction, mapTask, type BackgroundTask, type TaskRow } from "./background-task-records.js";
import { BACKGROUND_TASK_EVENT_ATTEMPTS, BACKGROUND_TASK_EVENT_RETRY_MS } from "./background-task-config.js";

export interface BackgroundTaskEvent {
  readonly attemptCount: number;
  readonly createdAt: Date;
  readonly id: string;
  readonly kind: "outcome" | "question";
  readonly leaseToken: string;
  readonly questionSeq: number;
  readonly task: BackgroundTask;
  /** The turn an earlier attempt created; the next attempt lets it finish instead of answering again. */
  readonly turnId: string | null;
}

interface EventRow {
  attempt_count: number;
  created_at: Date;
  id: string;
  kind: "outcome" | "question";
  lease_token: string;
  question_seq: number;
  task_id: string;
  turn_id: string | null;
}

/**
 * The chat's lane is busy while one of its updates waits or runs, or a wake-up holds it. An update bound
 * to an album or burst head follows that head, exactly as the update claim treats it.
 */
const LANE_BUSY = `EXISTS (
  SELECT 1 FROM telegram_ingress_queues queue
   WHERE queue.id = task.ingress_queue_id
     AND (queue.active_wakeup_id IS NOT NULL OR EXISTS (
       SELECT 1 FROM telegram_ingress_updates item
        WHERE item.queue_id = queue.id AND (item.media_group_leader_id IS NULL OR item.media_group_late)
          AND item.status IN ('pending', 'processing'))))`;

export const backgroundTaskEventRepository = {
  /** One due event of a chat whose lane is free, leased; or one whose lease expired. */
  async claim(now: Date, leaseMs: number): Promise<BackgroundTaskEvent | null> {
    return await inTransaction(async (client) => {
      const result = await client.query<EventRow>(
        `UPDATE background_task_events
            SET status = 'processing', lease_token = gen_random_uuid(),
                lease_expires_at = $1::timestamptz + $2 * interval '1 millisecond'
          WHERE id = (
            SELECT event.id FROM background_task_events event
              JOIN background_tasks task ON task.id = event.task_id
             WHERE ((event.status = 'pending' AND event.available_at <= $1 AND NOT ${LANE_BUSY}
                     AND EXISTS (SELECT 1 FROM runtime_maintenance WHERE singleton AND phase = 'ready'))
                OR (event.status = 'processing' AND event.lease_expires_at <= $1
                     -- A dead attempt that made no turn starts a new one: it waits behind the person too.
                     AND (event.turn_id IS NOT NULL OR NOT ${LANE_BUSY})
                     AND EXISTS (SELECT 1 FROM runtime_maintenance WHERE singleton
                       AND (phase = 'ready' OR (phase = 'draining' AND event.turn_id IS NOT NULL)))))
             ORDER BY event.available_at, event.id LIMIT 1 FOR UPDATE OF event SKIP LOCKED)
          RETURNING id::text, task_id::text, kind, question_seq, attempt_count, lease_token::text, turn_id, created_at`,
        [now, leaseMs],
      );
      const row = result.rows[0];
      if (!row) return null;
      const owner = await client.query<TaskRow>("SELECT * FROM background_tasks WHERE id = $1", [row.task_id]);
      return {
        attemptCount: row.attempt_count, createdAt: row.created_at, id: row.id, kind: row.kind, leaseToken: row.lease_token,
        questionSeq: row.question_seq, task: mapTask(owner.rows[0]!), turnId: row.turn_id,
      };
    });
  },

  /** Inside the transaction that creates the answering turn; false when the lease was lost meanwhile. */
  async bindTurn(client: Pick<PoolClient, "query">, event: Pick<BackgroundTaskEvent, "id" | "leaseToken">, turnId: string): Promise<boolean> {
    const result = await client.query(
      "UPDATE background_task_events SET turn_id = $3 WHERE id = $1 AND lease_token = $2 AND status = 'processing'",
      [event.id, event.leaseToken, turnId],
    );
    return result.rowCount === 1;
  },

  /** The main agent answered the event; an outcome makes its task reported. */
  async answer(event: Pick<BackgroundTaskEvent, "id" | "leaseToken">, now: Date): Promise<boolean> {
    return await inTransaction(async (client) => {
      const result = await client.query<{ kind: string; task_id: string }>(
        `UPDATE background_task_events SET status = 'answered', answered_at = $3, lease_token = NULL, lease_expires_at = NULL
          WHERE id = $1 AND lease_token = $2 AND status = 'processing' RETURNING kind, task_id::text`,
        [event.id, event.leaseToken, now],
      );
      const row = result.rows[0];
      if (!row) return false;
      if (row.kind === "outcome") {
        await client.query(
          `UPDATE background_tasks SET state = 'reported', reported_at = $2, updated_at = $2
            WHERE id = $1 AND finished_at IS NOT NULL AND reported_at IS NULL`,
          [row.task_id, now],
        );
      }
      return true;
    });
  },

  /**
   * The chat has no conversation to answer in right now (a new context nobody wrote into yet, or a card
   * waiting for a person): the event waits without spending an attempt.
   */
  async defer(event: Pick<BackgroundTaskEvent, "id" | "leaseToken">, code: string, now: Date): Promise<boolean> {
    const result = await database().query(
      `UPDATE background_task_events
          SET status = 'pending', last_error_code = $3, lease_token = NULL, lease_expires_at = NULL,
              available_at = $4::timestamptz + $5 * interval '1 millisecond'
        WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND turn_id IS NULL`,
      [event.id, event.leaseToken, code, now, BACKGROUND_TASK_EVENT_RETRY_MS],
    );
    return result.rowCount === 1;
  },

  /** Nobody can be told any more (the author left, the chat stayed silent a day): the event is closed. */
  async giveUp(event: Pick<BackgroundTaskEvent, "id" | "leaseToken">, code: string): Promise<boolean> {
    const result = await database().query(
      `UPDATE background_task_events
          SET status = 'gave_up', last_error_code = $3, lease_token = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_token = $2 AND status = 'processing'`,
      [event.id, event.leaseToken, code],
    );
    return result.rowCount === 1;
  },

  /**
   * The answer failed: again after the pause, or given up after the last attempt. A failure that does not
   * spend an attempt (the model hub is out for now) only waits for the pause.
   */
  async retry(
    event: Pick<BackgroundTaskEvent, "id" | "leaseToken">,
    code: string,
    now: Date,
    options: { readonly pauseMs: number; readonly spendsAttempt: boolean },
  ): Promise<"gave_up" | "retry" | null> {
    const spent = options.spendsAttempt ? 1 : 0;
    const result = await database().query<{ status: "gave_up" | "pending" }>(
      `UPDATE background_task_events
          SET attempt_count = attempt_count + $7, last_error_code = $3, lease_token = NULL, lease_expires_at = NULL, turn_id = NULL,
              status = CASE WHEN attempt_count + $7 >= $5 THEN 'gave_up' ELSE 'pending' END,
              available_at = $4::timestamptz + $6 * interval '1 millisecond'
        WHERE id = $1 AND lease_token = $2 AND status = 'processing' RETURNING status`,
      [event.id, event.leaseToken, code, now, BACKGROUND_TASK_EVENT_ATTEMPTS, options.pauseMs, spent],
    );
    const status = result.rows[0]?.status;
    return status === undefined ? null : status === "gave_up" ? "gave_up" : "retry";
  },
};
