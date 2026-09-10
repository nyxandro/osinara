/**
 * Terminal state for interactive and background memory-review batches.
 *
 * Exports:
 * - `memoryReviewTerminalRepository`: replay-safe completion/failure and pre-Eve source release.
 * - `resolveAbandonedReviewBatch`: the one terminal decision for a turn that never reports.
 * - `terminalizeAbandonedReviewTurns`: last-resort time bound for a turn that went silent.
 * - `advanceCompletedChain`: shared cursor advancement for terminal and operator decisions.
 */
import type { PoolClient } from "pg";

import { SESSION_RETENTION_DAYS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE,
  MEMORY_REVIEW_ABANDONED_TURN_TIMEOUT_MILLISECONDS,
} from "./memory-review-config.js";
import { enqueueMemoryReviewOwnerAlert } from "./memory-review-owner-alert-repository.js";
import { terminalizeApplicationSession } from "./memory-review-session-terminal.js";

export type MemoryReviewTerminalResult = "recorded" | "released" | "replayed" | "skipped";
export type MemoryReviewCompletionResult = MemoryReviewTerminalResult | "failed";

const SOURCE_BINDING_MISSING = "AGENT_MEMORY_REVIEW_SOURCE_BINDING_MISSING";
const BATCH_RESOLVED = "AGENT_MEMORY_REVIEW_BATCH_RESOLVED";
const PASS_SKIPPED = "AGENT_MEMORY_REVIEW_PASS_SKIPPED";
const TURN_CANCELLED = "AGENT_MEMORY_REVIEW_TURN_CANCELLED";
const TURN_ABANDONED = "AGENT_MEMORY_REVIEW_TURN_ABANDONED";

export async function advanceCompletedChain(client: PoolClient, laneId: string): Promise<void> {
  const lane = await client.query<{ processed_through_sequence: string }>(
    `SELECT processed_through_sequence::text FROM memory_review_lanes
      WHERE id = $1 FOR UPDATE`,
    [laneId],
  );
  let cursor = lane.rows[0]!.processed_through_sequence;
  while (true) {
    const next = await client.query<{ through_sequence: string }>(
      `SELECT through_sequence::text FROM memory_review_batches
        WHERE lane_id = $1 AND predecessor_sequence = $2
          AND status IN ('completed', 'skipped')`,
      [laneId, cursor],
    );
    const through = next.rows[0]?.through_sequence;
    if (!through) break;
    cursor = through;
  }
  await client.query(
    `UPDATE memory_review_lanes SET processed_through_sequence = $2, updated_at = now()
      WHERE id = $1`,
    [laneId, cursor],
  );
}

async function retireAbandonedReviewSession(
  client: PoolClient,
  applicationSessionId: string,
  now: Date,
): Promise<void> {
  // Only the background review session is orphaned by an abandoned turn: `retireAbandonedTasks`
  // covers `task` kinds and retention covers retired rows, so nothing else would ever close it,
  // and its bound sources would hold the group timeline against pruning forever. An interactive
  // batch shares the live chat session, whose lifecycle belongs to the Telegram channel.
  const retired = await client.query(
    `UPDATE conversation_sessions
        SET pending_operation = false, task_state = 'failed', retired_at = $2,
            delete_after = $2::timestamptz + $3 * interval '1 day'
      WHERE id = $1 AND kind = 'proactive' AND retired_at IS NULL`,
    [applicationSessionId, now, SESSION_RETENTION_DAYS],
  );
  if (retired.rowCount !== 1) return;
  await client.query(
    `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
     SELECT family_id, 'session.noncanonical_retired', id,
            jsonb_build_object('kind', kind::text, 'taskState', task_state::text)
       FROM conversation_sessions WHERE id = $1`,
    [applicationSessionId],
  );
}

export type AbandonedReviewOutcome = "counted" | "released" | "skipped";

/**
 * The single terminal decision for a batch whose own turn will never report an outcome: it was
 * cancelled, it never reached Eve, or it went silent. Every such path used to end differently, and
 * two of those endings — `failed` and `ambiguous` — hold the lane cursor forever, because
 * `(lane_id, predecessor_sequence)` is unique and `laneBlocked` refuses to reuse that place.
 *
 * Provenance decides, not the reason for the loss. A turn that already wrote memory counts as
 * reviewed, because repeating it would duplicate what it stored. A turn that provably wrote
 * nothing gives its sources back to the unreviewed tail — but only while nothing stands behind it,
 * since later batches chain onto a stuck head and deleting that head would leave them unreachable
 * from the cursor. With a successor present the head is skipped instead: the row stays terminal,
 * the cursor passes through it, and the owner hears which messages no pass will ever see.
 */
export async function resolveAbandonedReviewBatch(
  client: PoolClient,
  input: {
    applicationSessionId: string | null;
    batchId: string;
    diagnosticCode: string;
    eveSessionId: string | null;
    eveTurnId: string | null;
    laneId: string;
    notifyOwner: boolean;
    now: Date;
  },
): Promise<AbandonedReviewOutcome> {
  // A turn writes memory only after `turn.started` bound its id, so a batch without that binding
  // cannot have written anything and needs no provenance lookup at all.
  const wrote = input.eveSessionId === null || input.eveTurnId === null
    ? 0
    : (await client.query(
      "SELECT 1 FROM memory_items_all WHERE source = $1 LIMIT 1",
      [`eve:${input.eveSessionId}:${input.eveTurnId}`],
    )).rowCount;
  // The lane is locked before the successor is looked up. `prepareInteractiveTurn` commits a new
  // batch behind a live head under that same lock, so without it a successor could appear between
  // this check and the delete below and end up unreachable from the cursor.
  await client.query(
    "SELECT 1 FROM memory_review_lanes WHERE id = $1 FOR UPDATE",
    [input.laneId],
  );
  const successor = await client.query(
    `SELECT 1 FROM memory_review_batches AS successor
      WHERE successor.lane_id = $1 AND successor.predecessor_sequence = (
        SELECT through_sequence FROM memory_review_batches WHERE id = $2
      ) LIMIT 1`,
    [input.laneId, input.batchId],
  );
  const outcome: AbandonedReviewOutcome = wrote
    ? "counted"
    : successor.rowCount ? "skipped" : "released";
  if (input.applicationSessionId !== null) {
    await retireAbandonedReviewSession(client, input.applicationSessionId, input.now);
  }
  if (outcome === "released") {
    await client.query("DELETE FROM memory_review_batches WHERE id = $1", [input.batchId]);
    return outcome;
  }
  await client.query(
    `UPDATE memory_review_batches
        SET status = $4::memory_review_batch_status, diagnostic_code = $2,
            completed_at = $3, updated_at = $3, lease_token = NULL, lease_expires_at = NULL
      WHERE id = $1`,
    [input.batchId, input.diagnosticCode, input.now,
      outcome === "counted" ? "completed" : "skipped"],
  );
  await advanceCompletedChain(client, input.laneId);
  await client.query(
    "DELETE FROM memory_review_batch_sources WHERE batch_id = $1",
    [input.batchId],
  );
  // Skipped sources are lost to review for good, which the owner has to hear about under one
  // stable code. A counted pass did write memory, so it stays an operational record.
  if (outcome === "skipped" && input.notifyOwner) {
    await enqueueMemoryReviewOwnerAlert(client, input.batchId, PASS_SKIPPED);
  }
  return outcome;
}

/**
 * A running batch holds no lease: once its turn reaches Eve, the batch waits for that turn's own
 * terminal event and for nothing else. A turn that never reports back — a lost event, a killed
 * process, a restart in the middle of a pass — would hold its lane forever.
 *
 * A turn parked for a human answer is alive and is left alone: its application session carries the
 * pending flag until the answer or the timeout arrives. A session removed by retention nulls the
 * batch's reference to it, and such a batch has nothing left to wait for at all.
 */
export async function terminalizeAbandonedReviewTurns(
  client: PoolClient,
  now: Date,
): Promise<void> {
  const abandoned = await client.query<{
    application_session_id: string | null;
    eve_session_id: string;
    eve_turn_id: string | null;
    from_sequence: string;
    id: string;
    lane_id: string;
    through_sequence: string;
  }>(
    `SELECT batch.id, batch.lane_id, batch.application_session_id, batch.eve_session_id,
            batch.eve_turn_id, batch.from_sequence::text, batch.through_sequence::text
       FROM memory_review_batches AS batch
       LEFT JOIN conversation_sessions AS session ON session.id = batch.application_session_id
      WHERE batch.status = 'running' AND batch.eve_session_id IS NOT NULL
        AND batch.started_at <= $1::timestamptz - $2::double precision * interval '1 millisecond'
        AND (session.id IS NULL OR session.retired_at IS NOT NULL
          OR session.pending_operation = false)
      ORDER BY batch.started_at, batch.id
      FOR UPDATE OF batch SKIP LOCKED
      LIMIT $3`,
    [now, MEMORY_REVIEW_ABANDONED_TURN_TIMEOUT_MILLISECONDS,
      MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE],
  );
  for (const batch of abandoned.rows) {
    const outcome = await resolveAbandonedReviewBatch(client, {
      applicationSessionId: batch.application_session_id,
      batchId: batch.id,
      diagnosticCode: TURN_ABANDONED,
      eveSessionId: batch.eve_session_id,
      eveTurnId: batch.eve_turn_id,
      laneId: batch.lane_id,
      notifyOwner: true,
      now,
    });
    console.error(JSON.stringify({
      batchId: batch.id,
      code: BATCH_RESOLVED,
      diagnosticCode: TURN_ABANDONED,
      eveSessionId: batch.eve_session_id,
      eveTurnId: batch.eve_turn_id,
      fromSequence: batch.from_sequence,
      laneId: batch.lane_id,
      outcome,
      throughSequence: batch.through_sequence,
    }));
  }
}

export const memoryReviewTerminalRepository = {
  async completeBatch(input: {
    batchId: string;
    completedAt: Date;
    eveSessionId: string;
    eveTurnId: string;
  }): Promise<MemoryReviewCompletionResult> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query<{
        application_session_id: string; diagnostic_code: string | null;
        eve_session_id: string | null; eve_turn_id: string | null; lane_id: string;
        status: string;
      }>(
        `SELECT lane_id, application_session_id, eve_session_id, eve_turn_id,
                status::text, diagnostic_code
           FROM memory_review_batches WHERE id = $1 FOR UPDATE`,
        [input.batchId],
      );
      const recorded = batch.rows[0];
      if (!recorded) {
        // A released batch leaves no row: the repeated terminal event describes the same outcome.
        await client.query("COMMIT");
        return "replayed";
      }
      const exactTurn = recorded.eve_session_id === input.eveSessionId &&
        recorded.eve_turn_id === input.eveTurnId;
      if (recorded.status === "skipped") {
        // Four paths now produce `skipped`, and its binding may be absent, so the exact-turn check
        // cannot apply. The pass is already terminal: a late completion event changes nothing.
        await client.query("COMMIT");
        return "replayed";
      }
      if (recorded.status === "completed" && exactTurn) {
        // Eve lifecycle events are at-least-once; an identical terminal replay is a no-op.
        await client.query("COMMIT");
        return "replayed";
      }
      if (recorded.status === "failed" && exactTurn &&
        recorded.diagnostic_code === SOURCE_BINDING_MISSING) {
        await client.query("COMMIT");
        return "failed";
      }
      if (!exactTurn || !["running", "dispatching"].includes(recorded.status)) {
        throw new AppError(
          "AGENT_MEMORY_REVIEW_COMPLETION_INVALID",
          "Пакет проверки памяти завершён с другим результатом или недоступен",
        );
      }

      const sourceBinding = await client.query(
        `SELECT 1 FROM memory_turn_source_sets
          WHERE memory_review_batch_id = $1 AND eve_session_id = $2 AND eve_turn_id = $3`,
        [input.batchId, input.eveSessionId, input.eveTurnId],
      );
      if (sourceBinding.rowCount !== 1) {
        await client.query(
          `UPDATE memory_review_batches
              SET status = 'failed', diagnostic_code = $2, completed_at = $3, updated_at = $3,
                  lease_token = NULL, lease_expires_at = NULL
            WHERE id = $1`,
          [input.batchId, SOURCE_BINDING_MISSING, input.completedAt],
        );
        await terminalizeApplicationSession(client, {
          applicationSessionId: recorded.application_session_id,
          completedAt: input.completedAt,
          eveSessionId: input.eveSessionId,
          outcome: "failed",
        });
        await enqueueMemoryReviewOwnerAlert(client, input.batchId, SOURCE_BINDING_MISSING);
        await client.query("COMMIT");
        return "failed";
      }

      await client.query(
        `UPDATE memory_review_batches
            SET status = 'completed', completed_at = $2, updated_at = $2,
                lease_token = NULL, lease_expires_at = NULL
          WHERE id = $1`,
        [input.batchId, input.completedAt],
      );
      await terminalizeApplicationSession(client, {
        applicationSessionId: recorded.application_session_id,
        completedAt: input.completedAt,
        eveSessionId: input.eveSessionId,
        outcome: "completed",
      });
      await advanceCompletedChain(client, recorded.lane_id);
      await client.query(
        "DELETE FROM memory_review_batch_sources WHERE batch_id = $1",
        [input.batchId],
      );
      await client.query("COMMIT");
      return "recorded";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * A failed interactive turn keeps the lane blocked, because `(lane_id, predecessor_sequence)` is
   * unique: no later batch can occupy the same cursor. That is correct only when the turn might
   * already have written memory, since a repeat would duplicate it. When the turn provably wrote
   * nothing, the batch is released instead: its sources return to the unreviewed tail and a later
   * turn reviews them normally, so one broken model call cannot stop the group from remembering.
   */
  async failRunning(input: {
    batchId: string;
    diagnosticCode: string;
    eveSessionId: string;
    eveTurnId: string;
  }): Promise<MemoryReviewTerminalResult> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<{
        application_session_id: string | null;
        diagnostic_code: string | null;
        eve_session_id: string | null;
        eve_turn_id: string | null;
        lane_id: string;
        status: string;
      }>(
        `SELECT lane_id, application_session_id, status::text, diagnostic_code,
                eve_session_id, eve_turn_id
           FROM memory_review_batches WHERE id = $1 FOR UPDATE`,
        [input.batchId],
      );
      const batch = claimed.rows[0];
      // Eve lifecycle events are at-least-once, and a released batch leaves no row at all: both
      // describe the same outcome. A different recorded outcome is a real disagreement about what
      // happened to this turn and fails closed instead of being overwritten.
      if (!batch) {
        await client.query("COMMIT");
        return "replayed";
      }
      if (batch.status !== "running") {
        if (batch.diagnostic_code !== input.diagnosticCode) throw new AppError(
          "AGENT_MEMORY_REVIEW_FAILURE_STATE_INVALID",
          "Проверка памяти завершена с другим результатом или недоступна",
        );
        await client.query("COMMIT");
        return "replayed";
      }
      // A turn cancelled before `turn.started` never bound itself, so the batch carries no session
      // at all and provably wrote nothing. A binding that belongs to another turn is a real
      // disagreement about this batch and fails closed. Provenance is read from the row, never
      // from the channel context, so a mismatch cannot silently release written memory.
      if (batch.eve_session_id !== null && (batch.eve_session_id !== input.eveSessionId ||
        batch.eve_turn_id !== input.eveTurnId)) {
        throw new AppError(
          "AGENT_MEMORY_REVIEW_FAILURE_STATE_INVALID",
          "Проверка памяти завершена с другим результатом или недоступна",
        );
      }
      const now = new Date();
      const outcome = await resolveAbandonedReviewBatch(client, {
        applicationSessionId: null,
        batchId: input.batchId,
        diagnosticCode: input.diagnosticCode,
        eveSessionId: batch.eve_session_id,
        eveTurnId: batch.eve_turn_id,
        laneId: batch.lane_id,
        notifyOwner: input.diagnosticCode !== TURN_CANCELLED,
        now,
      });
      if (batch.application_session_id !== null) {
        await terminalizeApplicationSession(client, {
          applicationSessionId: batch.application_session_id,
          completedAt: now,
          eveSessionId: input.eveSessionId,
          outcome: "failed",
        });
      }
      console.error(JSON.stringify({
        batchId: input.batchId,
        code: BATCH_RESOLVED,
        diagnosticCode: input.diagnosticCode,
        eveSessionId: batch.eve_session_id,
        eveTurnId: batch.eve_turn_id,
        outcome,
      }));
      await client.query("COMMIT");
      return outcome === "counted" ? "recorded" : outcome;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async failInteractivePreparation(batchId: string, diagnosticCode: string): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // Preparation fails before the turn exists, so this batch never bound a session and wrote
      // nothing. A `failed` row here used to sit mid-chain: `laneBlocked` only guards the cursor,
      // while `coveredThrough` stops in front of such a row, so the next prepared turn claimed the
      // same predecessor and every following message in the group failed on the unique index.
      const claimed = await client.query<{ lane_id: string }>(
        `SELECT lane_id FROM memory_review_batches
          WHERE id = $1 AND batch_kind = 'interactive' AND status = 'running'
            AND eve_session_id IS NULL FOR UPDATE`,
        [batchId],
      );
      const batch = claimed.rows[0];
      if (batch) {
        await resolveAbandonedReviewBatch(client, {
          applicationSessionId: null,
          batchId,
          diagnosticCode,
          eveSessionId: null,
          eveTurnId: null,
          laneId: batch.lane_id,
          notifyOwner: true,
          now: new Date(),
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
