/**
 * Durable agent schedule dispatch queue boundary.
 *
 * Exports:
 * - `ClaimedAgentSchedule`: leased, authorization-revalidated proactive agent run.
 * - `agentScheduleDispatchRepository`: claim, side-effect markers, run completion, and failure.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { recoverUnstartedAgentSchedules } from "./agent-schedule-recovery.js";
import { recordOperationalIncident } from "../operational-incidents/owner-alerts.js";
import {
  AGENT_SCHEDULE_DISPATCH_MAX_SAFE_ATTEMPTS,
} from "./agent-schedule-config.js";
import type {
  AgentScheduleRecurrenceKind,
  AgentScheduleScope,
} from "./agent-schedule-record.js";
import {
  completeDeliveredAgentScheduleRun,
  type CompleteDeliveredAgentScheduleRunInput,
} from "./agent-schedule-run-completion.js";
import {
  authorizeAgentScheduleDelivery,
  type AgentScheduleDeliveryAuthorizationInput,
} from "./agent-schedule-delivery-authorization.js";
import {
  failAgentScheduleRun,
  failAgentScheduleRunByIdentityForNotification,
  failAgentScheduleRunForNotification,
} from "./agent-schedule-run-failure.js";
import {
  beginAgentScheduleDispatch,
  markAgentScheduleRunning,
} from "./agent-schedule-dispatch-state.js";

export interface ClaimedAgentSchedule {
  authorUserId: string;
  capabilityAllowlist: string[];
  familyId: string;
  forumTopicId: string | null;
  groupId: string | null;
  historyWindowDays: number | null;
  id: string;
  leaseToken: string;
  messageThreadId: string | null;
  nextRunAt: string;
  recurrenceKind: AgentScheduleRecurrenceKind;
  role: "member" | "owner" | "recovery_owner";
  runId: string;
  scenarioPrompt: string;
  scope: AgentScheduleScope;
  telegramChatId: string;
  telegramChatType: "group" | "private" | "supergroup";
  telegramUserId: string;
  timezone: string;
  title: string;
  userRequest: string;
}

interface ClaimOptions {
  leaseMilliseconds: number;
  limit: number;
  now: Date;
}

interface CandidateRow {
  author_user_id: string;
  family_id: string;
  forum_topic_id: string | null;
  group_id: string | null;
  history_window_days: number | null;
  id: string;
  message_thread_id: string | null;
  next_run_at: Date;
  recurrence_kind: AgentScheduleRecurrenceKind;
  role: "member" | "owner" | "recovery_owner";
  scenario_prompt: string;
  scope: AgentScheduleScope;
  telegram_chat_id: string;
  telegram_chat_type: "group" | "private" | "supergroup";
  telegram_user_id: string;
  timezone: string;
  title: string;
  tool_allowlist: string[];
  user_request: string;
}

interface ClaimedRow extends CandidateRow {
  lease_token: string;
  run_id: string;
}

function requireClaimOptions(options: ClaimOptions): void {
  if (
    !(options.now instanceof Date) ||
    Number.isNaN(options.now.getTime()) ||
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    !Number.isInteger(options.leaseMilliseconds) ||
    options.leaseMilliseconds < 1
  ) {
    throw new AppError(
      "AGENT_SCHEDULE_CLAIM_INVALID",
      "Диспетчер получил некорректные параметры агентных расписаний",
    );
  }
}

async function recordFailures(
  client: PoolClient,
  rows: readonly { family_id: string; id: string }[],
  errorCode: string,
): Promise<void> {
  for (const row of rows) {
    const run = (await client.query<{ id: string }>("SELECT id FROM agent_schedule_runs WHERE schedule_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [row.id])).rows[0];
    await recordOperationalIncident({ key: run ? `schedule-run:${run.id}` : `schedule:${row.id}:${errorCode}`,
      code: "AGENT_SCHEDULE_EXECUTION_FAILED", summary: "Не удалось выполнить агентное расписание. Проверьте состояние запуска.",
      context: { scheduleId: row.id, runId: run?.id ?? null, causeCode: errorCode } }, client);
    await client.query(
      `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
       VALUES ($1, 'agent_schedule.failed', $2, jsonb_build_object('code', $3::text))`,
      [row.family_id, row.id, errorCode],
    );
  }
}

export const agentScheduleDispatchRepository = {
  async claimDue(options: ClaimOptions): Promise<ClaimedAgentSchedule[]> {
    requireClaimOptions(options);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await recoverUnstartedAgentSchedules(client, options.now);

      // Only an unfinished Eve handoff expires; a confirmed running workflow owns its lifecycle.
      const ambiguous = await client.query<{ family_id: string; id: string; lease_token: string }>(
        `WITH expired AS (
           SELECT schedule.id, schedule.family_id, schedule.lease_token::text AS lease_token
             FROM agent_schedules AS schedule
            WHERE schedule.status = 'leased' AND schedule.lease_expires_at < $1
              AND schedule.dispatch_started_at IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM agent_schedule_runs AS run
                 WHERE run.schedule_id = schedule.id
                   AND run.lease_token = schedule.lease_token
                    AND run.status = 'dispatching'
                    AND run.recovery_protocol=0
              )
            FOR UPDATE
         ), updated AS (
           UPDATE agent_schedules AS schedule
              SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
                  dispatch_started_at = NULL,
                  last_error_code = 'AGENT_SCHEDULE_DELIVERY_AMBIGUOUS', updated_at = $1
             FROM expired
            WHERE schedule.id = expired.id
            RETURNING schedule.id, expired.family_id, expired.lease_token
         )
         SELECT id, family_id, lease_token FROM updated`,
        [options.now],
      );
      for (const row of ambiguous.rows) {
        await client.query(
          `UPDATE agent_schedule_runs
              SET status = 'ambiguous', error_code = 'AGENT_SCHEDULE_DELIVERY_AMBIGUOUS', updated_at = $3
            WHERE schedule_id = $1 AND lease_token = $2 AND status IN ('claimed', 'dispatching')`,
          [row.id, row.lease_token, options.now],
        );
        await client.query(
          `DELETE FROM agent_schedule_history_snapshots AS snapshot
            USING agent_schedule_runs AS run
            WHERE snapshot.run_id = run.id AND run.schedule_id = $1
              AND run.lease_token = $2 AND run.status = 'ambiguous'`,
          [row.id, row.lease_token],
        );
      }
      await recordFailures(client, ambiguous.rows, "AGENT_SCHEDULE_DELIVERY_AMBIGUOUS");

      // Crashes before handoff are safe to recover, but only for bounded attempts.
      const exhausted = await client.query<{ family_id: string; id: string }>(
        `UPDATE agent_schedules
            SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
                last_error_code = 'AGENT_SCHEDULE_ATTEMPTS_EXHAUSTED', updated_at = $1
          WHERE status = 'leased' AND lease_expires_at < $1 AND dispatch_started_at IS NULL
            AND attempts >= $2
          RETURNING id, family_id`,
        [options.now, AGENT_SCHEDULE_DISPATCH_MAX_SAFE_ATTEMPTS],
      );
      for (const row of exhausted.rows) {
        const terminalRuns = await client.query<{ id: string }>(
          `UPDATE agent_schedule_runs
              SET status = 'failed', error_code = 'AGENT_SCHEDULE_ATTEMPTS_EXHAUSTED',
                  completed_at = $2, updated_at = $2
             WHERE schedule_id = $1 AND status = 'claimed' AND dispatch_started_at IS NULL`,
          [row.id, options.now],
        );
        if (terminalRuns.rowCount) {
          await client.query(
            `DELETE FROM agent_schedule_history_snapshots AS snapshot
              USING agent_schedule_runs AS run
              WHERE snapshot.run_id = run.id AND run.schedule_id = $1
                AND run.status = 'failed'`,
            [row.id],
          );
        }
      }
      await recordFailures(client, exhausted.rows, "AGENT_SCHEDULE_ATTEMPTS_EXHAUSTED");
      await client.query(
        `UPDATE agent_schedules
            SET status = 'active', lease_token = NULL, lease_expires_at = NULL, updated_at = $1
          WHERE status = 'leased' AND lease_expires_at < $1 AND dispatch_started_at IS NULL
            AND attempts < $2`,
        [options.now, AGENT_SCHEDULE_DISPATCH_MAX_SAFE_ATTEMPTS],
      );

      // Removed memberships or changed trust zones invalidate proactive runs fail-closed.
      const invalid = await client.query<{ family_id: string; id: string }>(
        `UPDATE agent_schedules AS schedule
            SET status = 'failed', last_error_code = 'AGENT_SCHEDULE_DESTINATION_REVOKED',
                updated_at = $1
          WHERE schedule.status = 'active' AND (
             NOT EXISTS (
               SELECT 1 FROM family_memberships
                WHERE family_id = schedule.family_id AND user_id = schedule.author_user_id
              ) OR (
                schedule.scope = 'family' AND NOT EXISTS (
                 SELECT 1 FROM telegram_groups AS group_row
                  WHERE group_row.id = schedule.group_id
                    AND group_row.family_id = schedule.family_id
                    AND group_row.telegram_chat_id = schedule.telegram_chat_id
                    AND group_row.type = 'family_private'
                )
              ) OR (
                schedule.scope = 'group' AND (
                  NOT EXISTS (
                    SELECT 1 FROM family_memberships AS owner_membership
                     WHERE owner_membership.family_id = schedule.family_id
                       AND owner_membership.user_id = schedule.author_user_id
                       AND owner_membership.role = 'owner'
                  ) OR NOT EXISTS (
                    SELECT 1 FROM telegram_groups AS group_row
                     WHERE group_row.id = schedule.group_id
                       AND group_row.family_id = schedule.family_id
                       AND group_row.telegram_chat_id = schedule.telegram_chat_id
                       AND group_row.telegram_chat_type = schedule.telegram_chat_type
                       AND group_row.type = 'external'
                  )
                )
              )
           )
          RETURNING schedule.id, schedule.family_id`,
        [options.now],
      );
      for (const row of invalid.rows) {
        await client.query(
          `UPDATE agent_schedule_runs
              SET status = 'failed', error_code = 'AGENT_SCHEDULE_DESTINATION_REVOKED',
                  completed_at = $2, updated_at = $2
            WHERE schedule_id = $1 AND status = 'claimed' AND dispatch_started_at IS NULL`,
          [row.id, options.now],
        );
        await client.query(
          `DELETE FROM agent_schedule_history_snapshots AS snapshot
            USING agent_schedule_runs AS run
            WHERE snapshot.run_id = run.id AND run.schedule_id = $1
              AND run.status = 'failed'`,
          [row.id],
        );
      }
      await recordFailures(client, invalid.rows, "AGENT_SCHEDULE_DESTINATION_REVOKED");

      const candidates = await client.query<CandidateRow>(
        `SELECT schedule.id, schedule.family_id, schedule.author_user_id,
                schedule.group_id, schedule.scope, schedule.title, schedule.user_request,
                schedule.scenario_prompt, schedule.timezone, schedule.recurrence_kind,
                schedule.next_run_at, schedule.telegram_chat_id, schedule.telegram_chat_type,
                 schedule.message_thread_id::text, schedule.forum_topic_id::text,
                 schedule.history_window_days, schedule.tool_allowlist,
                 membership.role, users.telegram_user_id
           FROM agent_schedules AS schedule
           JOIN family_memberships AS membership
             ON membership.family_id = schedule.family_id AND membership.user_id = schedule.author_user_id
           JOIN users ON users.id = schedule.author_user_id
          WHERE schedule.status = 'active' AND schedule.next_run_at <= $1
            AND schedule.attempts < $3
          ORDER BY schedule.next_run_at, schedule.id
          FOR UPDATE OF schedule SKIP LOCKED
          LIMIT $2`,
        [options.now, options.limit, AGENT_SCHEDULE_DISPATCH_MAX_SAFE_ATTEMPTS],
      );

      const claimed: ClaimedAgentSchedule[] = [];
      for (const candidate of candidates.rows) {
        const updated = await client.query<ClaimedRow>(
          `UPDATE agent_schedules
              SET status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
                  lease_expires_at = $2::timestamptz + ($3::text || ' milliseconds')::interval,
                  dispatch_started_at = NULL, updated_at = $2
            WHERE id = $1 AND status = 'active'
            RETURNING lease_token::text`,
          [candidate.id, options.now, options.leaseMilliseconds],
        );
        const leaseToken = updated.rows[0]?.lease_token;
        if (!leaseToken) continue;
        // The same scheduled occurrence may be reclaimed only before Eve handoff starts.
        const run = await client.query<{ id: string }>(
          `INSERT INTO agent_schedule_runs
             (schedule_id, family_id, scheduled_for, status, lease_token, updated_at)
           VALUES ($1, $2, $3, 'claimed', $4, $5)
           ON CONFLICT (schedule_id, scheduled_for) DO UPDATE
             SET status = 'claimed', lease_token = EXCLUDED.lease_token,
                 dispatch_started_at = NULL, completed_at = NULL, error_code = NULL,
                 updated_at = EXCLUDED.updated_at
           WHERE agent_schedule_runs.status = 'claimed'
             AND agent_schedule_runs.dispatch_started_at IS NULL
           RETURNING id`,
          [candidate.id, candidate.family_id, candidate.next_run_at, leaseToken, options.now],
        );
        const runId = run.rows[0]?.id;
        if (!runId) {
          // A terminal run for this occurrence means retrying would duplicate side effects.
          const failed = await client.query<{ family_id: string }>(
            `UPDATE agent_schedules
                SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
                    dispatch_started_at = NULL, last_error_code = 'AGENT_SCHEDULE_RUN_CONFLICT',
                    updated_at = $2
              WHERE id = $1 AND status = 'leased' AND lease_token = $3
              RETURNING family_id`,
            [candidate.id, options.now, leaseToken],
          );
          await recordFailures(
            client,
            failed.rows.map((row) => ({ family_id: row.family_id, id: candidate.id })),
            "AGENT_SCHEDULE_RUN_CONFLICT",
          );
          continue;
        }
        claimed.push({
          authorUserId: candidate.author_user_id,
          capabilityAllowlist: candidate.tool_allowlist,
          familyId: candidate.family_id,
          forumTopicId: candidate.forum_topic_id,
          groupId: candidate.group_id,
          historyWindowDays: candidate.history_window_days,
          id: candidate.id,
          leaseToken,
          messageThreadId: candidate.message_thread_id,
          nextRunAt: candidate.next_run_at.toISOString(),
          recurrenceKind: candidate.recurrence_kind,
          role: candidate.role,
          runId,
          scenarioPrompt: candidate.scenario_prompt,
          scope: candidate.scope,
          telegramChatId: candidate.telegram_chat_id,
          telegramChatType: candidate.telegram_chat_type,
          telegramUserId: candidate.telegram_user_id,
          timezone: candidate.timezone,
          title: candidate.title,
          userRequest: candidate.user_request,
        });
      }

      await client.query("COMMIT");
      return claimed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  markDispatchStarted: beginAgentScheduleDispatch,
  markRunning: markAgentScheduleRunning,

  async authorizeDelivery(input: AgentScheduleDeliveryAuthorizationInput): Promise<void> {
    await authorizeAgentScheduleDelivery(input);
  },

  async completeDeliveredRun(input: CompleteDeliveredAgentScheduleRunInput): Promise<boolean> {
    const client = await database().connect();
    let result: Awaited<ReturnType<typeof completeDeliveredAgentScheduleRun>>;
    try {
      await client.query("BEGIN");
      result = await completeDeliveredAgentScheduleRun(client, input);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (result === "state_conflict") {
      throw new AppError(
        "AGENT_SCHEDULE_DELIVERY_STATE_INVALID",
        "Доставленный результат расписания сохранён, но состояние запуска повреждено",
      );
    }
    return result === "completed";
  },

  async failClaim(job: ClaimedAgentSchedule, errorCode: string): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const failed = await client.query<{ family_id: string }>(
        `UPDATE agent_schedules
            SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
                dispatch_started_at = NULL, last_error_code = $3, updated_at = now()
          WHERE id = $1 AND status = 'leased' AND lease_token = $2
          RETURNING family_id`,
        [job.id, job.leaseToken, errorCode],
      );
      if (!failed.rows[0]) {
        throw new AppError("AGENT_SCHEDULE_LEASE_STALE", "Ошибка запуска уже неактуальна");
      }
      await client.query(
        `UPDATE agent_schedule_runs
            SET status = 'failed', error_code = $4, completed_at = now(), updated_at = now()
          WHERE id = $1 AND schedule_id = $2 AND lease_token = $3`,
        [job.runId, job.id, job.leaseToken, errorCode],
      );
      // A terminal run cannot call the run-bound reader, so discard its transient history copy.
      await client.query("DELETE FROM agent_schedule_history_snapshots WHERE run_id = $1", [job.runId]);
      await recordFailures(client, [{ family_id: failed.rows[0].family_id, id: job.id }], errorCode);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  failRun: failAgentScheduleRun,
  failRunByIdentityForNotification: failAgentScheduleRunByIdentityForNotification,
  failRunForNotification: failAgentScheduleRunForNotification,
};
