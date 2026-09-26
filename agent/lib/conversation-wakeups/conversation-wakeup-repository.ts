/**
 * PostgreSQL lifecycle of wake-ups that run inside a chat's own conversation.
 *
 * Exports:
 * - `ConversationWakeupClaim`: a leased queue item, possibly one whose turn already started.
 * - `conversationWakeupRepository`: enqueue, claim, lease renewal, preparation, dispatch, and the
 *   terminal transitions of the queue item.
 *
 * Key constructs:
 * - A wake-up shares the chat's FIFO lane with Telegram updates and yields to them: a waiting one
 *   is claimed only when that queue holds no waiting or running update. A claimed one marks the
 *   queue row, and every update waits for that mark to go.
 * - Both claims lock the same queue row. The wake-up claim reads the updates again after that
 *   lock, and the update claim reads the mark from the row it locks, so neither can overtake the
 *   other when both are claimed at the same moment.
 * - A claimed wake-up whose processor died is reclaimed even when updates wait behind it: it still
 *   owns the lane, so only its own recovery can free it.
 * - While a wake-up waits, its schedule stays leased with an infinite lease: how long it waits is
 *   decided by the chat queue, not by the scheduler's timer.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { prepareConversationWakeup } from "./conversation-wakeup-preparation.js";
import {
  CONVERSATION_CHANGED_CODE,
  closeWakeup,
  failUnstartedRun,
  inTransaction,
  WAKEUP_LEASE_LOST_CODE,
  wakeupLeaseLost,
  withdrawUnstartedRun,
} from "./conversation-wakeup-transitions.js";

export interface ConversationWakeupDispatch {
  admissionDeadlineAt: Date;
  eveSessionId: string;
  id: string;
  startIndex: number;
}

export interface ConversationWakeupClaim {
  attemptCount: number;
  /** Set once the turn was handed to Eve; such an item is observed, never sent again. */
  dispatch: ConversationWakeupDispatch | null;
  /** The turn Eve admitted for this run, when it reached admission. */
  eveTurnId: string | null;
  id: string;
  leaseToken: string;
  queueId: string;
  runId: string;
  scheduleId: string;
}

interface ClaimRow {
  admission_deadline_at: Date | null;
  attempt_count: number;
  dispatch_id: string | null;
  dispatch_start_index: string | null;
  eve_session_id: string | null;
  eve_turn_id: string | null;
  id: string;
  lease_token: string;
  queue_id: string;
  run_id: string;
  schedule_id: string;
}

/**
 * Any Telegram update of the queue that is waiting, running, or blocking it after a lost cancel. A
 * row bound to an album or burst head follows that head, exactly as the update claim treats it.
 */
function laneHasUpdates(queueId: string): string {
  return `EXISTS (
    SELECT 1 FROM telegram_ingress_updates item
     WHERE item.queue_id = ${queueId} AND (item.media_group_leader_id IS NULL OR item.media_group_late)
       AND (item.status IN ('pending', 'processing') OR (
         item.status = 'failed' AND item.last_error_code = 'AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED')))`;
}

function mapClaim(row: ClaimRow): ConversationWakeupClaim {
  const dispatched = row.dispatch_id !== null && row.eve_session_id !== null &&
    row.dispatch_start_index !== null && row.admission_deadline_at !== null;
  return {
    attemptCount: row.attempt_count,
    dispatch: dispatched
      ? {
          admissionDeadlineAt: row.admission_deadline_at!,
          eveSessionId: row.eve_session_id!,
          id: row.dispatch_id!,
          startIndex: Number(row.dispatch_start_index),
        }
      : null,
    eveTurnId: row.eve_turn_id,
    id: row.id,
    leaseToken: row.lease_token,
    queueId: row.queue_id,
    runId: row.run_id,
    scheduleId: row.schedule_id,
  };
}

async function requireOwned(
  client: PoolClient,
  claim: Pick<ConversationWakeupClaim, "id" | "leaseToken">,
): Promise<{ dispatch_started_at: Date | null; eve_session_id: string | null }> {
  const owned = await client.query<{ dispatch_started_at: Date | null; eve_session_id: string | null; owned: boolean }>(
    `SELECT dispatch_started_at, eve_session_id, status = 'processing' AND lease_token = $2 AS owned
       FROM telegram_ingress_wakeups WHERE id = $1
      FOR UPDATE`,
    [claim.id, claim.leaseToken],
  );
  const row = owned.rows[0];
  // A turn refused before admission withdraws its own run, and the item goes with it.
  if (!row) throw new AppError(WAKEUP_LEASE_LOST_CODE, "Пробуждение уже снято вместе со своим запуском");
  if (!row.owned) throw wakeupLeaseLost();
  return row;
}

export const conversationWakeupRepository = {
  /**
   * Hands a leased conversation occurrence to its chat queue. Without a live conversation binding
   * the schedule is parked instead, because its note has no context anywhere else.
   */
  async enqueue(job: { id: string; leaseToken: string; runId: string }): Promise<"parked" | "queued"> {
    return await inTransaction(async (client) => {
      const schedule = await client.query<{ conversation_session_id: string | null; ingress_queue_id: string | null }>(
        `SELECT conversation_session_id::text, ingress_queue_id::text FROM agent_schedules
          WHERE id = $1 AND status = 'leased' AND lease_token = $2 AND execution_context = 'conversation'
            AND dispatch_started_at IS NULL
          FOR UPDATE`,
        [job.id, job.leaseToken],
      );
      const row = schedule.rows[0];
      if (!row) throw new AppError("AGENT_SCHEDULE_LEASE_STALE", "Запуск расписания уже неактуален");
      const run = await client.query(
        `UPDATE agent_schedule_runs
            SET status = 'dispatching', dispatch_started_at = now(), recovery_protocol = 2,
                application_session_id = $4, updated_at = now()
          WHERE id = $1 AND schedule_id = $2 AND lease_token = $3 AND status = 'claimed'`,
        [job.runId, job.id, job.leaseToken, row.conversation_session_id],
      );
      if (run.rowCount !== 1) throw new AppError("AGENT_SCHEDULE_LEASE_STALE", "Запуск расписания уже неактуален");
      if (row.conversation_session_id === null || row.ingress_queue_id === null) {
        await withdrawUnstartedRun(client, job.id, job.runId, CONVERSATION_CHANGED_CODE);
        return "parked";
      }
      await client.query(
        `UPDATE agent_schedules SET dispatch_started_at = now(), lease_expires_at = 'infinity', updated_at = now()
          WHERE id = $1`,
        [job.id],
      );
      await client.query(
        "INSERT INTO telegram_ingress_wakeups (queue_id, schedule_id, run_id) VALUES ($1, $2, $3)",
        [row.ingress_queue_id, job.id, job.runId],
      );
      return "queued";
    });
  },

  /** Claims a wake-up whose chat lane is free, or reclaims one whose processor lost its lease. */
  async claimNext(leaseMilliseconds: number): Promise<ConversationWakeupClaim | null> {
    return await inTransaction(async (client) => {
      const candidate = await client.query<{ id: string; queue_id: string; status: "pending" | "processing" }>(
        `WITH admission AS MATERIALIZED (
           SELECT phase FROM runtime_maintenance WHERE singleton FOR SHARE
         )
         SELECT wakeup.id::text, wakeup.queue_id::text, wakeup.status
           FROM telegram_ingress_wakeups wakeup
           JOIN telegram_ingress_queues queue ON queue.id = wakeup.queue_id
          WHERE ((wakeup.status = 'pending' AND wakeup.available_at <= now() AND queue.active_wakeup_id IS NULL
                  AND EXISTS (SELECT 1 FROM admission WHERE phase = 'ready')
                  AND NOT ${laneHasUpdates("wakeup.queue_id")})
              OR (wakeup.status = 'processing' AND wakeup.lease_expires_at <= now()
                  AND EXISTS (SELECT 1 FROM admission WHERE phase = 'ready' OR
                    (phase = 'draining' AND wakeup.dispatch_started_at IS NOT NULL))))
          ORDER BY wakeup.status = 'processing' DESC, wakeup.created_at, wakeup.id
          FOR UPDATE OF wakeup, queue SKIP LOCKED
          LIMIT 1`,
      );
      const found = candidate.rows[0];
      if (!found) return null;
      if (found.status === "pending") {
        // The first read may predate an update claimed a moment ago. With the queue row locked, this
        // fresh read sees every update claim that committed before the lock.
        const busy = await client.query<{ busy: boolean }>(`SELECT ${laneHasUpdates("$1::uuid")} AS busy`, [found.queue_id]);
        if (busy.rows[0]?.busy) return null;
      }
      const claimed = await client.query<ClaimRow>(
        `UPDATE telegram_ingress_wakeups wakeup
            SET status = 'processing', attempt_count = attempt_count + 1, lease_token = gen_random_uuid(),
                lease_expires_at = now() + ($2 * interval '1 millisecond'), updated_at = now()
          WHERE wakeup.id = $1
          RETURNING wakeup.id::text, wakeup.lease_token::text, wakeup.queue_id::text, wakeup.run_id::text,
                    wakeup.schedule_id::text, wakeup.attempt_count, wakeup.eve_session_id,
                    wakeup.dispatch_id::text, wakeup.admission_deadline_at, wakeup.dispatch_start_index::text,
                    (SELECT run.eve_turn_id FROM agent_schedule_runs run WHERE run.id = wakeup.run_id) AS eve_turn_id`,
        [found.id, leaseMilliseconds],
      );
      await client.query("UPDATE telegram_ingress_queues SET active_wakeup_id = $2 WHERE id = $1", [found.queue_id, found.id]);
      return mapClaim(claimed.rows[0]!);
    });
  },

  async renewLease(id: string, leaseToken: string, leaseMilliseconds: number): Promise<void> {
    const result = await database().query(
      `UPDATE telegram_ingress_wakeups
          SET lease_expires_at = now() + ($3 * interval '1 millisecond'), updated_at = now()
        WHERE id = $1 AND status = 'processing' AND lease_token = $2 AND lease_expires_at > now()`,
      [id, leaseToken, leaseMilliseconds],
    );
    if (result.rowCount !== 1) throw wakeupLeaseLost();
  },

  prepare: prepareConversationWakeup,

  /**
   * Fixes where the turn's events start, which dispatch marks them, and until when Eve may still
   * admit the turn, all before Eve receives it. After this point a crash is recovered by observing
   * the session, never by sending the wake-up again.
   */
  async markDispatched(
    claim: Pick<ConversationWakeupClaim, "id" | "leaseToken" | "runId">,
    eveSessionId: string,
    dispatch: { admissionDeadlineAt: Date; id: string },
  ): Promise<number> {
    return await inTransaction(async (client) => {
      const cursor = await client.query<{ next_event_index: string }>(
        "SELECT next_event_index::text FROM eve_session_event_cursors WHERE eve_session_id = $1",
        [eveSessionId],
      );
      const startIndex = Number(cursor.rows[0]?.next_event_index ?? 0);
      const marked = await client.query(
        `UPDATE telegram_ingress_wakeups
            SET dispatch_started_at = now(), eve_session_id = $3, dispatch_start_index = $4, dispatch_id = $5,
                admission_deadline_at = $6, updated_at = now()
          WHERE id = $1 AND status = 'processing' AND lease_token = $2 AND lease_expires_at > now()
            AND dispatch_started_at IS NULL`,
        [claim.id, claim.leaseToken, eveSessionId, startIndex, dispatch.id, dispatch.admissionDeadlineAt],
      );
      if (marked.rowCount !== 1) throw wakeupLeaseLost();
      const run = await client.query(
        `UPDATE agent_schedule_runs SET status = 'running', eve_session_id = $2, updated_at = now()
          WHERE id = $1 AND status = 'dispatching'`,
        [claim.runId, eveSessionId],
      );
      if (run.rowCount !== 1) throw new AppError("AGENT_SCHEDULE_ATTEMPT_STALE", "Попытка запуска расписания уже закрыта");
      return startIndex;
    });
  },

  /** The turn Eve admitted for the run, or null while none was admitted and the run is still open. */
  async admittedTurn(runId: string): Promise<{ eveTurnId: string | null; open: boolean }> {
    const run = await database().query<{ eve_turn_id: string | null; open: boolean }>(
      "SELECT eve_turn_id, status IN ('dispatching', 'running') AS open FROM agent_schedule_runs WHERE id = $1",
      [runId],
    );
    // A removed run was withdrawn: it is closed and no turn owns it.
    const row = run.rows[0];
    return { eveTurnId: row?.eve_turn_id ?? null, open: row?.open === true };
  },

  /** Closes the queue item and advances the session's event cursor in one step. */
  async complete(claim: Pick<ConversationWakeupClaim, "id" | "leaseToken">, eveSessionId: string, nextEventIndex: number): Promise<void> {
    if (!Number.isSafeInteger(nextEventIndex) || nextEventIndex < 0) {
      throw new AppError("AGENT_TELEGRAM_SESSION_CURSOR_INVALID", "Eve вернул некорректную позицию потока событий сессии");
    }
    await inTransaction(async (client) => {
      const owned = await requireOwned(client, claim);
      if (owned.eve_session_id !== eveSessionId) throw wakeupLeaseLost();
      await closeWakeup(client, claim.id, { status: "completed" });
      await client.query(
        `INSERT INTO eve_session_event_cursors (eve_session_id, next_event_index) VALUES ($1, $2)
         ON CONFLICT (eve_session_id) DO UPDATE SET next_event_index = EXCLUDED.next_event_index, updated_at = now()
         WHERE eve_session_event_cursors.next_event_index <= EXCLUDED.next_event_index`,
        [eveSessionId, nextEventIndex],
      );
    });
  },

  /**
   * Parks a wake-up whose turn provably never started: Eve refused the session, or the turn never
   * reached admission. Returns false when a turn was admitted meanwhile and now owns the run.
   */
  async withdrawNotStarted(
    claim: Pick<ConversationWakeupClaim, "id" | "leaseToken" | "runId" | "scheduleId">,
    code: string,
  ): Promise<boolean> {
    return await inTransaction(async (client) => {
      await requireOwned(client, claim);
      return await withdrawUnstartedRun(client, claim.scheduleId, claim.runId, code);
    });
  },

  /**
   * Terminal failure of the queue item. Before the handoff no turn exists, so the run and its
   * schedule fail here. After it a turn may have started and leaves no trustworthy cursor: its
   * canonical conversation is rotated before the next message reuses it, and the run is left to
   * that turn's own completion or, if it never reports, to the scheduler's sweep.
   */
  async fail(
    claim: Pick<ConversationWakeupClaim, "id" | "leaseToken" | "runId" | "scheduleId">,
    failure: { code: string; message: string },
  ): Promise<void> {
    await inTransaction(async (client) => {
      const owned = await requireOwned(client, claim);
      await closeWakeup(client, claim.id, { ...failure, status: "failed" });
      if (owned.dispatch_started_at === null) {
        await failUnstartedRun(client, claim.scheduleId, claim.runId, failure.code);
        return;
      }
      await client.query(
        `UPDATE conversation_sessions SET rotation_requested_at = now()
          WHERE eve_session_id = $1 AND kind = 'canonical' AND retired_at IS NULL`,
        [owned.eve_session_id],
      );
    });
  },
};
