/**
 * SQL-backed completion helpers for scheduled agent runs.
 *
 * Exports:
 * - `finishActiveAgentScheduleRun`: marks a running Eve handoff completed or failed and advances recurrence.
 * - `completeDeliveredAgentScheduleRun`: atomically records Telegram delivery and successful completion.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { nextAnchoredOccurrence } from "../scheduling/next-occurrence.js";
import { recordProactiveDelivery } from "../proactive-deliveries/proactive-delivery-repository.js";
import type { AgentScheduleRecurrenceKind } from "./agent-schedule-record.js";

interface ActiveRunRow {
  family_id: string;
  recurrence_kind: AgentScheduleRecurrenceKind;
  run_id: string;
  schedule_id: string;
}

interface NextOccurrenceRow {
  next_index: number;
  next_run_at: Date;
}

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

async function nextWeeklyOccurrence(
  client: PoolClient,
  scheduleId: string,
  after: Date,
): Promise<NextOccurrenceRow | null> {
  const result = await client.query<NextOccurrenceRow>(
    `WITH schedule AS (
       SELECT id, timezone, recurrence_interval, recurrence_days_of_week,
              recurrence_anchor_local, occurrence_index
         FROM agent_schedules WHERE id = $1
     ), candidates AS (
       SELECT schedule.occurrence_index + row_number() OVER (ORDER BY candidate.local_time) AS next_index,
              candidate.local_time AT TIME ZONE schedule.timezone AS next_run_at
         FROM schedule
         CROSS JOIN LATERAL (
           SELECT (($2 AT TIME ZONE schedule.timezone)::date + days.day_offset + schedule.recurrence_anchor_local::time) AS local_time
             FROM generate_series(0, schedule.recurrence_interval * 7 + 7) AS days(day_offset)
         ) AS candidate
        WHERE extract(isodow FROM candidate.local_time)::int = ANY(schedule.recurrence_days_of_week)
          AND mod(
            floor(extract(epoch FROM (date_trunc('week', candidate.local_time) - date_trunc('week', schedule.recurrence_anchor_local))) / 604800)::int,
            schedule.recurrence_interval
          ) = 0
          AND candidate.local_time AT TIME ZONE schedule.timezone > $2
     )
     SELECT next_index, next_run_at FROM candidates ORDER BY next_run_at LIMIT 1`,
    [scheduleId, after],
  );
  return result.rows[0] ?? null;
}

async function nextOccurrence(
  client: PoolClient,
  scheduleId: string,
  recurrenceKind: AgentScheduleRecurrenceKind,
  after: Date,
): Promise<NextOccurrenceRow | null> {
  if (recurrenceKind === "once") return null;
  if (recurrenceKind === "weekly") return await nextWeeklyOccurrence(client, scheduleId, after);
  return await nextAnchoredOccurrence(client, "agent_schedules", scheduleId, after);
}

export async function finishActiveAgentScheduleRun(
  client: PoolClient,
  input: { applicationSessionId: string; completedAt: Date; errorCode: string | null; eveSessionId: string },
): Promise<boolean> {
  const active = await client.query<ActiveRunRow>(
    `SELECT run.id AS run_id, schedule.id AS schedule_id, schedule.family_id,
            schedule.recurrence_kind
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

  // The run row is terminal before the schedule is re-opened, avoiding overlap windows.
  await client.query(
    `UPDATE agent_schedule_runs
        SET status = $2, completed_at = $3, error_code = $4, updated_at = $3
      WHERE id = $1`,
    [row.run_id, input.errorCode === null ? "completed" : "failed", input.completedAt, input.errorCode],
  );
  // History chunks exist only to serve the active model run and must not become retained copies.
  await client.query("DELETE FROM agent_schedule_history_snapshots WHERE run_id = $1", [row.run_id]);

  const next = await nextOccurrence(client, row.schedule_id, row.recurrence_kind, input.completedAt);
  if (!next) {
    await client.query(
      `UPDATE agent_schedules
          SET status = $2, lease_token = NULL, lease_expires_at = NULL,
              dispatch_started_at = NULL, last_error_code = $3, updated_at = $4
        WHERE id = $1`,
      [
        row.schedule_id,
        input.errorCode === null ? "completed" : "failed",
        input.errorCode,
        input.completedAt,
      ],
    );
    return true;
  }

  await client.query(
    `UPDATE agent_schedules
        SET status = 'active', occurrence_index = $2, next_run_at = $3,
            attempts = 0, lease_token = NULL, lease_expires_at = NULL,
            dispatch_started_at = NULL, last_error_code = $4, updated_at = $5
      WHERE id = $1`,
    [row.schedule_id, next.next_index, next.next_run_at, input.errorCode, input.completedAt],
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
    errorCode: null,
    eveSessionId: input.eveSessionId,
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
