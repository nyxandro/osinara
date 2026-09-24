/**
 * SQL-backed completion helpers for scheduled agent runs.
 *
 * Exports:
 * - `AgentScheduleRunOutcome`: delivered result, deliberate silence, or failure with its code.
 * - `finishActiveAgentScheduleRun`: marks a running Eve handoff completed or failed and advances recurrence.
 * - `completeDeliveredAgentScheduleRun`: atomically records Telegram delivery and successful completion.
 *
 * Key construct:
 * - A deliberately silent run advances `completed_runs` like a delivered one: `max_runs` limits
 *   executions, and a limited scenario that keeps finding nothing to report must still end.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { recordOperationalIncident } from "../operational-incidents/owner-alerts.js";
import { nextAgentScheduleOccurrence } from "./agent-schedule-next-occurrence.js";
import { recordProactiveDelivery } from "../proactive-deliveries/proactive-delivery-repository.js";
import type { AgentScheduleRecurrenceKind } from "./agent-schedule-record.js";

interface ActiveRunRow {
  delivery_may_have_happened: boolean;
  completed_runs: number;
  max_runs: number | null;
  pause_requested: boolean;
  family_id: string;
  recurrence_kind: AgentScheduleRecurrenceKind;
  run_id: string;
  schedule_id: string;
}

const UNCONFIRMED_DELIVERY_CODES = new Set([
  "AGENT_SCHEDULE_DELIVERY_AMBIGUOUS",
  "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING",
  "AGENT_TELEGRAM_MESSAGE_DELIVERY_AMBIGUOUS",
  "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS",
  "AGENT_TELEGRAM_FINAL_DELIVERY_AMBIGUOUS",
]);

export type AgentScheduleRunOutcome =
  | { kind: "delivered" }
  // The model finished the run with Eve's empty-delivery marker, as its scenario allowed.
  | { kind: "silent" }
  | { errorCode: string; kind: "failed" };

// Silence claimed after a delivery may already have started cannot be told apart from a lost receipt.
const SILENCE_AFTER_DELIVERY_CODE = "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING";

export interface CompleteDeliveredAgentScheduleRunInput {
  applicationSessionId: string;
  content: string;
  deliveredAt: Date;
  eveSessionId: string;
  familyId: string;
  groupId: string | null;
  messageThreadId: string | null;
  ownerUserId: string | null;
  runId: string;
  scheduledFor: Date;
  scope: "family" | "group" | "personal";
  telegramChatId: string;
  telegramMessageId: string;
  title: string;
}

export async function finishActiveAgentScheduleRun(
  client: PoolClient,
  input: {
    applicationSessionId: string;
    completedAt: Date;
    eveSessionId: string;
    outcome: AgentScheduleRunOutcome;
  },
): Promise<boolean> {
  const active = await client.query<ActiveRunRow>(
    `SELECT run.id AS run_id, schedule.id AS schedule_id, schedule.family_id,
            schedule.recurrence_kind, schedule.max_runs, schedule.completed_runs, schedule.pause_requested,
            EXISTS (
              SELECT 1 FROM telegram_final_deliveries delivery
              WHERE delivery.application_session_id = run.application_session_id
                AND delivery.eve_session_id = run.eve_session_id
                AND (run.eve_turn_id IS NULL OR delivery.eve_turn_id = run.eve_turn_id)
                AND (delivery.status IN ('started','ambiguous','delivered') OR EXISTS (
                  SELECT 1 FROM telegram_final_delivery_chunks chunk WHERE chunk.delivery_id = delivery.id
                ))
            ) AS delivery_may_have_happened
       FROM agent_schedule_runs AS run
       JOIN agent_schedules AS schedule ON schedule.id = run.schedule_id
      WHERE run.application_session_id = $1
        AND run.eve_session_id = $2
        AND run.status = 'running'
        AND schedule.status = 'leased'
      FOR UPDATE OF run, schedule`,
    [input.applicationSessionId, input.eveSessionId],
  );
  const row = active.rows[0];
  if (!row) return false;
  const outcome: AgentScheduleRunOutcome = input.outcome.kind === "silent" && row.delivery_may_have_happened
    ? { errorCode: SILENCE_AFTER_DELIVERY_CODE, kind: "failed" }
    : input.outcome;
  const errorCode = outcome.kind === "failed" ? outcome.errorCode : null;
  if (errorCode !== null) await recordOperationalIncident({ key: `schedule-run:${row.run_id}`,
    code: "AGENT_SCHEDULE_EXECUTION_FAILED", summary: "Агентный сценарий завершился с ошибкой. Проверьте результат перед повтором.",
    context: { runId: row.run_id, scheduleId: row.schedule_id, causeCode: errorCode } }, client);

  // The run row is terminal before the schedule is re-opened, avoiding overlap windows.
  await client.query(
    `UPDATE agent_schedule_runs
        SET status = $2, completed_at = $3, error_code = $4, updated_at = $3
      WHERE id = $1`,
    [row.run_id, errorCode === null ? "completed" : "failed", input.completedAt, errorCode],
  );
  // History chunks exist only to serve the active model run and must not become retained copies.
  await client.query("DELETE FROM agent_schedule_history_snapshots WHERE run_id = $1", [row.run_id]);

  const completedRuns = row.completed_runs + (errorCode === null ? 1 : 0);
  const limitReached = row.max_runs !== null && completedRuns >= row.max_runs;
  // A storage error can hide the transport's ambiguity code. The durable outbox is authoritative.
  const deliveryUnconfirmed = errorCode !== null &&
    (row.delivery_may_have_happened || UNCONFIRMED_DELIVERY_CODES.has(errorCode));
  const next = limitReached || deliveryUnconfirmed
    ? null : await nextAgentScheduleOccurrence(client, row.schedule_id, row.recurrence_kind, input.completedAt);
  if (!next) {
    await client.query(
      `UPDATE agent_schedules
          SET status = $2, lease_token = NULL, lease_expires_at = NULL,
              dispatch_started_at = NULL, last_error_code = $3, updated_at = $4,
              completed_runs = $5, pause_requested = false
        WHERE id = $1`,
      [
        row.schedule_id,
        errorCode === null ? "completed" : "failed",
        errorCode,
        input.completedAt,
        completedRuns,
      ],
    );
    return true;
  }

  await client.query(
    `UPDATE agent_schedules
        SET status = $6, occurrence_index = $2, next_run_at = $3,
            attempts = 0, lease_token = NULL, lease_expires_at = NULL,
            dispatch_started_at = NULL, last_error_code = $4, updated_at = $5,
            completed_runs = $7, pause_requested = false
      WHERE id = $1`,
    [row.schedule_id, next.next_index, next.next_run_at, errorCode, input.completedAt,
      row.pause_requested ? "paused" : "active", completedRuns],
  );
  return true;
}

export async function completeDeliveredAgentScheduleRun(
  client: PoolClient,
  input: CompleteDeliveredAgentScheduleRunInput,
): Promise<"completed" | "duplicate" | "state_conflict"> {
  // The trusted run id anchors the receipt even if later lifecycle validation finds corruption.
  const run = await client.query<{ identity_matches: boolean; status: string }>(
    `SELECT status::text,
            application_session_id = $2::uuid AND eve_session_id = $3 AS identity_matches
       FROM agent_schedule_runs
      WHERE id = $1`,
    [input.runId, input.applicationSessionId, input.eveSessionId],
  );
  const durableRun = run.rows[0];
  if (!durableRun) {
    throw new AppError(
      "AGENT_SCHEDULE_DELIVERY_STATE_INVALID",
      "Доставленный результат расписания не связан с активным запуском",
    );
  }

  // Telegram has already accepted the message, so its exact receipt must survive any state conflict.
  await recordProactiveDelivery(client, {
    content: input.content,
    deliveredAt: input.deliveredAt,
    familyId: input.familyId,
    groupId: input.groupId,
    messageThreadId: input.messageThreadId,
    ownerUserId: input.ownerUserId,
    scheduledFor: input.scheduledFor,
    scope: input.scope,
    sourceId: input.runId,
    sourceKind: "agent_schedule",
    telegramChatId: input.telegramChatId,
    telegramMessageId: input.telegramMessageId,
    title: input.title,
  });
  if (!durableRun.identity_matches || durableRun.status !== "running") {
    return durableRun.identity_matches && durableRun.status === "completed"
      ? "duplicate"
      : "state_conflict";
  }

  // Normal state completion and the already-written receipt commit in the same transaction.
  const completed = await finishActiveAgentScheduleRun(client, {
    applicationSessionId: input.applicationSessionId,
    completedAt: input.deliveredAt,
    eveSessionId: input.eveSessionId,
    outcome: { kind: "delivered" },
  });
  if (completed) return "completed";

  // A concurrent Eve replay may finish after the initial state read; accept its exact receipt.
  const existing = await client.query(
    `SELECT 1
       FROM agent_schedule_runs run
       JOIN proactive_deliveries delivery
         ON delivery.source_kind = 'agent_schedule' AND delivery.source_id = run.id
      WHERE run.id = $1 AND run.application_session_id = $2 AND run.eve_session_id = $3
        AND run.status = 'completed' AND delivery.telegram_message_id = $4::bigint`,
    [input.runId, input.applicationSessionId, input.eveSessionId, input.telegramMessageId],
  );
  return existing.rowCount === 1 ? "duplicate" : "state_conflict";
}
