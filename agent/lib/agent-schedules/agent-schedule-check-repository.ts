/**
 * PostgreSQL transitions of a monitor's tick: the scheduler runs its check without the model.
 *
 * Exports:
 * - `ScheduleCheckTarget`: a claimed monitor, revalidated, with the chat sandbox it checks in.
 * - `ScheduleCheckState`: what one tick leaves on the schedule: when it checked, failures in a row.
 * - `scheduleCheckRepository`: prepare a check change, load a target, finish a tick without the
 *   model, or wake the agent.
 *
 * Key constructs:
 * - A tick without a wake-up is not a run: its claimed run row is removed, the result counter and
 *   the run limit stay untouched, and the next tick is planned.
 * - The next tick never lands after `check_until`; the tick due at it is the monitor's last.
 * - A wake-up records why it woke the agent on its run in the same commit that queues it.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { loadLiveConversationSession, type LiveConversationSession } from "../conversation-wakeups/conversation-live-session.js";
import { enqueueConversationWakeup } from "../conversation-wakeups/conversation-wakeup-repository.js";
import { CONVERSATION_CHANGED_CODE, inTransaction, parkLeasedSchedule } from "../conversation-wakeups/conversation-wakeup-transitions.js";
import { conversationCanonicalRouteToken } from "../conversation-wakeups/conversation-wakeup-turn.js";
import { recordOperationalIncident } from "../operational-incidents/owner-alerts.js";
import { SCHEDULE_CHECK_UNAVAILABLE_BEFORE_INCIDENT, type ScheduleCheckTrigger } from "./agent-schedule-check-contract.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import { requireCheckChangedInScheduleChat } from "./agent-schedule-conversation.js";
import { nextAgentScheduleOccurrence } from "./agent-schedule-next-occurrence.js";
import type { AgentScheduleRecurrenceKind } from "./agent-schedule-record.js";
import { requireAgentScheduleMutationAccess, selectAgentSchedule } from "./agent-schedule-repository-helpers.js";

/** A claimed monitor tick; `nextRunAt` is the moment it was due. */
export interface ScheduleCheckTick {
  id: string;
  leaseToken: string;
  nextRunAt: string;
  runId: string;
}

export interface ScheduleCheckTarget {
  authorUserId: string;
  checkCommand: string;
  checkFailures: number;
  checkUnavailable: number;
  checkUntil: Date;
  familyId: string;
  groupId: string | null;
  role: "member" | "owner" | "recovery_owner";
  sandbox: LiveConversationSession;
  scope: "family" | "personal";
  telegramChatId: string;
  telegramChatType: "group" | "private" | "supergroup";
}

export interface ScheduleCheckState {
  /** False when the check could not run at all; the last check time then stays as it was. */
  checked: boolean;
  errorCode: string | null;
  failures: number;
  /** Ticks in a row whose check could not run at all. */
  unavailable: number;
}

interface TargetRow {
  author_user_id: string;
  check_command: string;
  check_failures: number;
  check_unavailable: number;
  check_until: Date;
  conversation_session_id: string | null;
  family_id: string;
  forum_topic_id: string | null;
  group_id: string | null;
  message_thread_id: string | null;
  role: "member" | "owner" | "recovery_owner" | null;
  scope: "family" | "personal";
  telegram_chat_id: string;
  telegram_chat_type: "group" | "private" | "supergroup";
}

function leaseStale(): AppError {
  return new AppError("AGENT_SCHEDULE_LEASE_STALE", "Запуск расписания уже неактуален");
}

/** Locks the claimed tick; a tick whose lease moved on belongs to nobody here. */
async function lockTick(client: PoolClient, tick: ScheduleCheckTick): Promise<{ recurrence_kind: AgentScheduleRecurrenceKind }> {
  const locked = await client.query<{ recurrence_kind: AgentScheduleRecurrenceKind }>(
    `SELECT schedule.recurrence_kind
       FROM agent_schedules schedule
       JOIN agent_schedule_runs run
         ON run.id = $3 AND run.schedule_id = schedule.id AND run.lease_token = schedule.lease_token
        AND run.status = 'claimed'
      WHERE schedule.id = $1 AND schedule.status = 'leased' AND schedule.lease_token = $2
        AND schedule.dispatch_started_at IS NULL AND schedule.check_command IS NOT NULL
      FOR UPDATE OF schedule, run`,
    [tick.id, tick.leaseToken, tick.runId],
  );
  const row = locked.rows[0];
  if (!row) throw leaseStale();
  return row;
}

async function saveCheckState(client: PoolClient, tick: ScheduleCheckTick, state: ScheduleCheckState, now: Date): Promise<void> {
  await client.query(
    `UPDATE agent_schedules
        SET check_failures = $2, check_unavailable = $3, last_check_error_code = $4,
            last_checked_at = CASE WHEN $5 THEN $6 ELSE last_checked_at END, updated_at = $6
      WHERE id = $1`,
    [tick.id, state.failures, state.unavailable, state.errorCode, state.checked, now],
  );
  // Raised once per streak: the count passes this value exactly once before a check runs again.
  if (state.unavailable === SCHEDULE_CHECK_UNAVAILABLE_BEFORE_INCIDENT) {
    await recordOperationalIncident({
      code: "AGENT_SCHEDULE_CHECK_UNAVAILABLE",
      context: { runId: tick.runId, scheduleId: tick.id, unavailableInRow: state.unavailable },
      key: `schedule-check-unavailable:${tick.runId}`,
      summary: "Проверка монитора несколько раз подряд не смогла запуститься. Проверьте песочницу: пока она недоступна, монитор не видит событий.",
    }, client);
  }
}

export const scheduleCheckRepository = {
  /**
   * Runs before a monitor's check is tried out: a call already applied is reported as replayed, and
   * an update must target a schedule of this chat that is free to change, so nothing runs in vain.
   */
  async prepareChange(
    auth: AgentScheduleAuthorization,
    input: { id?: string; operationKey: string },
  ): Promise<"ready" | "replayed"> {
    const applied = await database().query(
      "SELECT 1 FROM agent_schedule_operations WHERE family_id = $1 AND operation_key = $2",
      [auth.familyId, input.operationKey],
    );
    if (applied.rowCount) return "replayed";
    if (input.id === undefined) return "ready";
    const client = await database().connect();
    try {
      const schedule = await selectAgentSchedule(client, auth.familyId, input.id);
      if (!schedule) throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Агентное расписание не найдено");
      await requireAgentScheduleMutationAccess(client, auth, schedule);
      requireCheckChangedInScheduleChat(auth, schedule);
      if (schedule.status === "leased" && auth.wakeupScheduleId !== input.id) {
        throw new AppError(
          "AGENT_SCHEDULE_RUN_IN_PROGRESS",
          "Запланированный сценарий сейчас выполняется. Повторите изменение после завершения",
        );
      }
      return "ready";
    } finally {
      client.release();
    }
  },

  /**
   * Revalidates the claimed tick and finds the chat sandbox it checks in. A conversation the chat
   * has left behind parks the monitor, as a wake-up would be parked; `null` means nothing to check.
   */
  async loadTarget(tick: ScheduleCheckTick): Promise<ScheduleCheckTarget | null> {
    return await inTransaction(async (client) => {
      await lockTick(client, tick);
      const loaded = await client.query<TargetRow>(
        `SELECT schedule.author_user_id::text, schedule.check_command, schedule.check_failures,
                schedule.check_unavailable, schedule.check_until,
                schedule.conversation_session_id::text, schedule.family_id::text, schedule.forum_topic_id::text,
                schedule.group_id::text, schedule.message_thread_id::text, membership.role, schedule.scope,
                schedule.telegram_chat_id, schedule.telegram_chat_type
           FROM agent_schedules schedule
           LEFT JOIN family_memberships membership
             ON membership.family_id = schedule.family_id AND membership.user_id = schedule.author_user_id
          WHERE schedule.id = $1`,
        [tick.id],
      );
      const row = loaded.rows[0]!;
      const sandbox = await loadLiveConversationSession(client, {
        baseContinuationToken: conversationCanonicalRouteToken({
          groupId: row.scope === "family" ? row.group_id : null,
          messageThreadId: row.message_thread_id,
          telegramChatId: row.telegram_chat_id,
          telegramForumTopicId: row.forum_topic_id,
        }),
        conversationSessionId: row.conversation_session_id,
      });
      // The claim already failed schedules whose author left; a role lost since then is the same.
      if (row.role === null) {
        throw new AppError("AGENT_SCHEDULE_DESTINATION_REVOKED", "Автор монитора больше не состоит в семье");
      }
      if (sandbox === null) {
        await client.query("DELETE FROM agent_schedule_runs WHERE id = $1", [tick.runId]);
        await parkLeasedSchedule(client, tick.id, CONVERSATION_CHANGED_CODE);
        return null;
      }
      return {
        authorUserId: row.author_user_id,
        checkCommand: row.check_command,
        checkFailures: row.check_failures,
        checkUnavailable: row.check_unavailable,
        checkUntil: row.check_until,
        familyId: row.family_id,
        groupId: row.group_id,
        role: row.role,
        sandbox,
        scope: row.scope,
        telegramChatId: row.telegram_chat_id,
        telegramChatType: row.telegram_chat_type,
      };
    });
  },

  /** Ends a tick that did not wake the agent: no run is kept, and the next tick is planned. */
  async finishTick(tick: ScheduleCheckTick, state: ScheduleCheckState, now: Date): Promise<void> {
    await inTransaction(async (client) => {
      const { recurrence_kind: kind } = await lockTick(client, tick);
      await client.query("DELETE FROM agent_schedule_runs WHERE id = $1", [tick.runId]);
      const next = await nextAgentScheduleOccurrence(client, tick.id, kind, now);
      if (!next) throw new AppError("AGENT_SCHEDULE_CHECK_RECURRENCE_INVALID", "У монитора нет следующей проверки");
      await saveCheckState(client, tick, state, now);
      await client.query(
        `UPDATE agent_schedules
            SET status = CASE WHEN pause_requested THEN 'paused'::agent_schedule_status ELSE 'active'::agent_schedule_status END,
                pause_requested = false, lease_token = NULL, lease_expires_at = NULL, dispatch_started_at = NULL,
                attempts = 0, occurrence_index = $2, next_run_at = least($3::timestamptz, check_until)
          WHERE id = $1`,
        [tick.id, next.next_index, next.next_run_at],
      );
    });
  },

  /** Wakes the agent in its conversation with what the check found, or with the end of the window. */
  async wake(
    tick: ScheduleCheckTick,
    wake: { output: string | null; trigger: ScheduleCheckTrigger },
    state: ScheduleCheckState,
    now: Date,
  ): Promise<"parked" | "queued"> {
    return await inTransaction(async (client) => {
      await lockTick(client, tick);
      await client.query(
        "UPDATE agent_schedule_runs SET check_trigger = $2, check_output = $3, updated_at = $4 WHERE id = $1",
        [tick.runId, wake.trigger, wake.output, now],
      );
      await saveCheckState(client, tick, state, now);
      return await enqueueConversationWakeup(client, tick);
    });
  },
};
