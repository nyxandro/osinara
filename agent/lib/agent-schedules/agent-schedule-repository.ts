/**
 * Scoped PostgreSQL agent schedule CRUD boundary.
 *
 * Exports:
 * - `AgentScheduleCreateInput` and `AgentScheduleUpdateInput`: validated mutation inputs.
 * - `agentScheduleRepository`: replay-safe create/list/update/delete/run-now operations.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { isPauseOnlyUpdate, requireAgentScheduleMaxRuns, requireScheduleLimitConsistency, requireScheduleLimitRemaining } from "./agent-schedule-limits.js";
import { advanceReactivatedSchedule } from "./agent-schedule-next-occurrence.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import { recurrenceValues } from "./agent-schedule-recurrence.js";
import {
  type AgentScheduleExecutionContext,
  type AgentScheduleRecord,
  type AgentScheduleRecurrence,
  type AgentScheduleRow,
  type AgentScheduleScope,
  agentScheduleOperationHash,
  rowToAgentSchedule,
} from "./agent-schedule-record.js";
import {
  findAgentScheduleById,
  listAgentSchedules,
} from "./agent-schedule-query-repository.js";
import {
  AGENT_SCHEDULE_COLUMNS,
  findAgentScheduleOperation,
  lockAgentScheduleOperation,
  requireAgentScheduleMutationAccess,
  requireAgentScheduleTimezone,
  requireCurrentScheduleMembership,
  selectAgentSchedule,
} from "./agent-schedule-repository-helpers.js";
import {
  type AgentScheduleInputRecurrence,
  requireAgentScheduleDate,
  requireAgentSchedulePrompt,
  requireAgentScheduleRecurrence,
  requireAgentScheduleTitle,
  requireAgentScheduleUserRequest,
} from "./agent-schedule-validation.js";
import {
  type ConversationBinding,
  isConversationWakeupIdle,
  rebindConversationSchedule,
  requireConversationBinding,
  requireConversationCapacity,
  requireConversationRunLimit,
  requireExecutionContext,
} from "./agent-schedule-conversation.js";
import {
  type ExternalScheduleCapability,
  requireExternalScheduleHistoryWindowDays,
  requireUpdatedExternalScheduleCapabilities,
} from "./external-agent-schedule-policy.js";

export interface AgentScheduleCreateInput {
  executionContext: AgentScheduleExecutionContext;
  maxRuns?: number | null;
  firstRunAt: Date;
  operationKey: string;
  recurrence: AgentScheduleInputRecurrence;
  scenarioPrompt: string;
  scope: Exclude<AgentScheduleScope, "group">;
  timezone: string;
  title: string;
  userRequest: string;
}

export interface AgentScheduleUpdateInput {
  maxRuns?: number | null;
  capabilityAllowlist?: ExternalScheduleCapability[];
  enabled?: boolean;
  historyWindowDays?: number | null;
  nextRunAt?: Date;
  operationKey: string;
  recurrence?: AgentScheduleInputRecurrence;
  requiredScope?: AgentScheduleScope;
  scenarioPrompt?: string;
  title?: string;
  userRequest?: string;
}

function requireDestination(auth: AgentScheduleAuthorization, scope: AgentScheduleScope): void {
  // Destination is accepted only from the verified current Telegram conversation.
  if (scope === "personal" && auth.telegramChatType !== "private") {
    throw new AppError(
      "AGENT_SCHEDULE_DESTINATION_INVALID",
      "Личный агентный сценарий можно запланировать только в личном чате",
    );
  }
  if (scope === "family" && (auth.groupType !== "family_private" || !auth.groupId)) {
    throw new AppError(
      "AGENT_SCHEDULE_DESTINATION_INVALID",
      "Семейный агентный сценарий планируется только в зарегистрированной семейной группе",
    );
  }
}

export const agentScheduleRepository = {
  async create(
    auth: AgentScheduleAuthorization,
    input: AgentScheduleCreateInput,
  ): Promise<AgentScheduleRecord> {
    const title = requireAgentScheduleTitle(input.title);
    const userRequest = requireAgentScheduleUserRequest(input.userRequest);
    const scenarioPrompt = requireAgentSchedulePrompt(input.scenarioPrompt);
    const firstRunAt = requireAgentScheduleDate(input.firstRunAt);
    const recurrence = requireAgentScheduleRecurrence(input.recurrence);
    const recurrenceValue = recurrenceValues(recurrence);
    const maxRuns = requireAgentScheduleMaxRuns(input.maxRuns);
    requireScheduleLimitConsistency(maxRuns === undefined ? null : maxRuns, 0, recurrence.kind);
    const conversation = requireExecutionContext(input.executionContext) === "conversation";
    if (conversation) requireConversationRunLimit(maxRuns);
    const inputHash = agentScheduleOperationHash({
      ...input,
      firstRunAt: firstRunAt.toISOString(),
      recurrence,
      scenarioPrompt,
      title,
      userRequest,
    });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentScheduleMembership(client, auth);
      await lockAgentScheduleOperation(client, auth, input.operationKey);
      const replay = await findAgentScheduleOperation(
        client,
        auth,
        input.operationKey,
        "create",
        inputHash,
      );
      if (replay !== undefined) {
        if (!replay) throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Расписание уже удалено");
        const existing = await selectAgentSchedule(client, auth.familyId, replay);
        if (!existing) throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Расписание уже удалено");
        await client.query("COMMIT");
        return rowToAgentSchedule(existing);
      }
      const timezone = await requireAgentScheduleTimezone(client, input.timezone);
      requireDestination(auth, input.scope);
      if (input.scope === "family") {
        const group = await client.query(
          `SELECT 1 FROM telegram_groups
           WHERE id = $1 AND family_id = $2 AND telegram_chat_id = $3 AND type = 'family_private'`,
          [auth.groupId, auth.familyId, auth.telegramChatId],
        );
        if (!group.rowCount) {
          throw new AppError(
            "AGENT_SCHEDULE_DESTINATION_INVALID",
            "Семейная группа больше не зарегистрирована",
          );
        }
      }
      let binding: ConversationBinding | null = null;
      if (conversation) {
        binding = await requireConversationBinding(client, auth);
        await requireConversationCapacity(client, auth.familyId, binding.ingressQueueId, null);
      }
      const inserted = await client.query<AgentScheduleRow>(
        `INSERT INTO agent_schedules
           (family_id, owner_user_id, author_user_id, group_id, scope, title,
            user_request, scenario_prompt, timezone, recurrence_kind,
            recurrence_interval, recurrence_days_of_week, recurrence_anchor_local, recurrence_anchor_at,
              next_run_at, telegram_chat_id, telegram_chat_type, message_thread_id, forum_topic_id, max_runs,
              execution_context, conversation_session_id, ingress_queue_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                  $13::timestamptz AT TIME ZONE $9, $13, $13, $14, $15, $16::bigint, $17::bigint, $18,
                  $19, $20::uuid, $21::uuid)
         RETURNING ${AGENT_SCHEDULE_COLUMNS}`,
        [
          auth.familyId,
          input.scope === "personal" ? auth.userId : null,
          auth.userId,
          input.scope === "personal" ? null : auth.groupId,
          input.scope,
          title,
          userRequest,
          scenarioPrompt,
          timezone,
          recurrenceValue.kind,
          recurrenceValue.interval,
          recurrenceValue.daysOfWeek,
          firstRunAt,
          auth.telegramChatId,
          auth.telegramChatType,
          input.scope === "personal" ? null : auth.messageThreadId,
          input.scope === "personal" ? null : auth.forumTopicId,
          maxRuns === undefined ? null : maxRuns,
          input.executionContext,
          binding?.conversationSessionId ?? null,
          binding?.ingressQueueId ?? null,
        ],
      );
      const schedule = inserted.rows[0]!;
      await client.query(
        `INSERT INTO agent_schedule_operations
           (family_id, operation_key, operation_kind, input_hash, schedule_id)
         VALUES ($1, $2, 'create', $3, $4)`,
        [auth.familyId, input.operationKey, inputHash, schedule.id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'agent_schedule.created', $3,
                 jsonb_build_object('scope', $4::text, 'recurrence', $5::text))`,
        [auth.familyId, auth.userId, schedule.id, input.scope, recurrenceValue.kind],
      );
      await client.query("COMMIT");
      return rowToAgentSchedule(schedule);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async list(
    auth: AgentScheduleAuthorization,
    options: { cursor?: string; limit: number },
  ): ReturnType<typeof listAgentSchedules> {
    return await listAgentSchedules(auth, options);
  },

  async findById(
    auth: AgentScheduleAuthorization,
    id: string,
  ): Promise<AgentScheduleRecord | null> {
    return await findAgentScheduleById(auth, id);
  },

  async update(
    auth: AgentScheduleAuthorization,
    id: string,
    input: AgentScheduleUpdateInput,
  ): Promise<AgentScheduleRecord> {
    if (
      input.capabilityAllowlist === undefined &&
      input.maxRuns === undefined &&
      input.enabled === undefined &&
      input.historyWindowDays === undefined &&
      input.nextRunAt === undefined &&
      input.recurrence === undefined &&
      input.scenarioPrompt === undefined &&
      input.title === undefined &&
      input.userRequest === undefined
    ) {
      throw new AppError("AGENT_SCHEDULE_UPDATE_INVALID", "Не указаны изменения расписания");
    }
    const title = input.title === undefined ? undefined : requireAgentScheduleTitle(input.title);
    const userRequest = input.userRequest === undefined
      ? undefined
      : requireAgentScheduleUserRequest(input.userRequest);
    const scenarioPrompt = input.scenarioPrompt === undefined
      ? undefined
      : requireAgentSchedulePrompt(input.scenarioPrompt);
    const nextRunAt = input.nextRunAt === undefined
      ? undefined
      : requireAgentScheduleDate(input.nextRunAt);
    const recurrence = input.recurrence === undefined
      ? undefined
      : requireAgentScheduleRecurrence(input.recurrence);
    const historyWindowDays = requireExternalScheduleHistoryWindowDays(input.historyWindowDays);
    const maxRuns = requireAgentScheduleMaxRuns(input.maxRuns);
    const inputHash = agentScheduleOperationHash({
      ...input,
      nextRunAt: nextRunAt?.toISOString(),
      recurrence,
      historyWindowDays,
      scenarioPrompt,
      title,
      userRequest,
    });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lockAgentScheduleOperation(client, auth, input.operationKey);
      const replay = await findAgentScheduleOperation(client, auth, input.operationKey, "update", inputHash);
      if (replay) {
        const existing = await selectAgentSchedule(client, auth.familyId, replay);
        if (!existing) throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Расписание уже удалено");
        await client.query("COMMIT");
        return rowToAgentSchedule(existing);
      }
      let schedule = await selectAgentSchedule(client, auth.familyId, id);
      if (!schedule) throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Агентное расписание не найдено");
      if (schedule.scope === "group" && schedule.group_id !== null) {
        // Group administration locks the trust-zone row before cascading schedules; use the same order.
        await client.query("SELECT 1 FROM telegram_groups WHERE id = $1 FOR SHARE", [schedule.group_id]);
      }
      schedule = await selectAgentSchedule(client, auth.familyId, id, true);
      if (!schedule) throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Агентное расписание не найдено");
      await requireAgentScheduleMutationAccess(client, auth, schedule);
      if (input.requiredScope !== undefined && schedule.scope !== input.requiredScope) {
        throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Агентное расписание не найдено");
      }
      if (input.historyWindowDays !== undefined && schedule.scope !== "group") {
        throw new AppError(
          "AGENT_EXTERNAL_SCHEDULE_HISTORY_WINDOW_INVALID",
          "Окно истории доступно только для автоматизации внешней группы",
        );
      }
      if (schedule.status === "leased" && !isPauseOnlyUpdate(input)) {
        throw new AppError(
          "AGENT_SCHEDULE_RUN_IN_PROGRESS",
          "Запланированный сценарий сейчас выполняется. Повторите изменение после завершения",
        );
      }
      const nextRecurrence = recurrence ?? {
        ...(schedule.recurrence_kind === "weekly"
          ? { daysOfWeek: schedule.recurrence_days_of_week ?? [] }
          : {}),
        interval: schedule.recurrence_interval,
        kind: schedule.recurrence_kind,
      } as AgentScheduleRecurrence;
      const recurrenceValue = recurrenceValues(nextRecurrence);
      const nextMaxRuns = maxRuns === undefined ? schedule.max_runs : maxRuns;
      if (schedule.execution_context === "conversation") requireConversationRunLimit(nextMaxRuns);
      requireScheduleLimitConsistency(nextMaxRuns, schedule.completed_runs, nextRecurrence.kind);
      if (input.enabled === true) requireScheduleLimitRemaining(nextMaxRuns, schedule.completed_runs);
      const capabilityAllowlist = await requireUpdatedExternalScheduleCapabilities(
        client,
        schedule,
        input.capabilityAllowlist,
      );
      if (input.enabled === true && schedule.execution_context === "conversation") {
        await rebindConversationSchedule(client, auth, schedule);
      }
      const scheduleChanged = nextRunAt !== undefined || recurrence !== undefined;
      const updated = await client.query<AgentScheduleRow>(
        `UPDATE agent_schedules
         SET title = $2,
             user_request = $3,
             scenario_prompt = $4,
             recurrence_kind = $5,
             recurrence_interval = $6,
             recurrence_days_of_week = $7,
              recurrence_anchor_local = CASE WHEN $8 THEN $9::timestamptz AT TIME ZONE timezone ELSE recurrence_anchor_local END,
              recurrence_anchor_at = CASE WHEN $8 THEN $9::timestamptz ELSE recurrence_anchor_at END,
             occurrence_index = CASE WHEN $8 THEN 0 ELSE occurrence_index END,
             next_run_at = CASE WHEN $8 THEN $9 ELSE next_run_at END,
              status = CASE WHEN status = 'leased' THEN status
                            WHEN $13::integer IS NOT NULL AND completed_runs >= $13 THEN 'completed'::agent_schedule_status
                            WHEN $10 = false THEN 'paused'::agent_schedule_status
                            WHEN $10 = true THEN 'active'::agent_schedule_status ELSE status END,
               pause_requested = (status = 'leased' AND $10 = false), max_runs = $13,
              attempts = CASE WHEN $8 OR $10 = true THEN 0 ELSE attempts END,
              -- A person pausing a wake-up that paused by itself takes it off the agent's resume list.
              last_error_code = CASE WHEN $8 OR $10 = true THEN NULL
                                     WHEN $10 = false AND status = 'paused' AND execution_context = 'conversation' THEN NULL
                                     ELSE last_error_code END,
              history_window_days = $11,
              tool_allowlist = $12,
              updated_at = now()
         WHERE id = $1
         RETURNING ${AGENT_SCHEDULE_COLUMNS}`,
        [
          id,
          title ?? schedule.title,
          userRequest ?? schedule.user_request,
          scenarioPrompt ?? schedule.scenario_prompt,
          recurrenceValue.kind,
          recurrenceValue.interval,
          recurrenceValue.daysOfWeek,
          scheduleChanged,
          nextRunAt ?? schedule.next_run_at,
          input.enabled ?? null,
          historyWindowDays === undefined ? schedule.history_window_days : historyWindowDays,
          capabilityAllowlist ?? schedule.tool_allowlist,
          nextMaxRuns,
        ],
      );
      if (input.enabled === true && nextRunAt === undefined) {
        await advanceReactivatedSchedule(client, id, nextRecurrence.kind);
        updated.rows[0] = (await selectAgentSchedule(client, auth.familyId, id))!;
      }
      await client.query(
        `INSERT INTO agent_schedule_operations
           (family_id, operation_key, operation_kind, input_hash, schedule_id)
         VALUES ($1, $2, 'update', $3, $4)`,
        [auth.familyId, input.operationKey, inputHash, id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'agent_schedule.updated', $3, '{}'::jsonb)`,
        [auth.familyId, auth.userId, id],
      );
      await client.query("COMMIT");
      return rowToAgentSchedule(updated.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async delete(
    auth: AgentScheduleAuthorization,
    id: string,
    operationKey: string,
    requiredScope?: AgentScheduleScope,
  ): Promise<boolean> {
    const inputHash = agentScheduleOperationHash({ id });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lockAgentScheduleOperation(client, auth, operationKey);
      const replay = await findAgentScheduleOperation(client, auth, operationKey, "delete", inputHash);
      if (replay !== undefined) {
        await client.query("COMMIT");
        return true;
      }
      const schedule = await selectAgentSchedule(client, auth.familyId, id, true);
      if (!schedule) throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Агентное расписание не найдено");
      await requireAgentScheduleMutationAccess(client, auth, schedule);
      if (requiredScope !== undefined && schedule.scope !== requiredScope) {
        throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Агентное расписание не найдено");
      }
      // A wake-up with no turn in progress goes away with its schedule: one still waiting in the chat
      // queue never started, and one whose observer was lost would otherwise keep it leased for good.
      if (schedule.status === "leased" && !await isConversationWakeupIdle(client, id)) {
        throw new AppError(
          "AGENT_SCHEDULE_RUN_IN_PROGRESS",
          "Запланированный сценарий сейчас выполняется. Повторите удаление после завершения",
        );
      }
      await client.query(
        `INSERT INTO agent_schedule_operations
           (family_id, operation_key, operation_kind, input_hash, schedule_id)
         VALUES ($1, $2, 'delete', $3, $4)`,
        [auth.familyId, operationKey, inputHash, id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'agent_schedule.deleted', $3, jsonb_build_object('scope', $4::text))`,
        [auth.familyId, auth.userId, id, schedule.scope],
      );
      await client.query("DELETE FROM agent_schedules WHERE id = $1", [id]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async runNow(
    auth: AgentScheduleAuthorization,
    id: string,
    operationKey: string,
    requiredScope?: AgentScheduleScope,
  ): Promise<AgentScheduleRecord> {
    const inputHash = agentScheduleOperationHash({ id });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lockAgentScheduleOperation(client, auth, operationKey);
      const replay = await findAgentScheduleOperation(client, auth, operationKey, "run_now", inputHash);
      if (replay) {
        const existing = await selectAgentSchedule(client, auth.familyId, replay);
        if (!existing) throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Расписание уже удалено");
        await client.query("COMMIT");
        return rowToAgentSchedule(existing);
      }
      const schedule = await selectAgentSchedule(client, auth.familyId, id, true);
      if (!schedule) throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Агентное расписание не найдено");
      await requireAgentScheduleMutationAccess(client, auth, schedule);
      if (requiredScope !== undefined && schedule.scope !== requiredScope) {
        throw new AppError("AGENT_SCHEDULE_NOT_FOUND", "Агентное расписание не найдено");
      }
      if (schedule.status === "leased") {
        throw new AppError(
          "AGENT_SCHEDULE_RUN_IN_PROGRESS",
          "Запланированный сценарий уже выполняется",
        );
      }
      requireScheduleLimitRemaining(schedule.max_runs, schedule.completed_runs);
      if (schedule.execution_context === "conversation") await rebindConversationSchedule(client, auth, schedule);
      const updated = await client.query<AgentScheduleRow>(
        `UPDATE agent_schedules
            SET status = 'active', next_run_at = now(), attempts = 0,
                pause_requested = false, last_error_code = NULL, updated_at = now()
          WHERE id = $1
          RETURNING ${AGENT_SCHEDULE_COLUMNS}`,
        [id],
      );
      await client.query(
        `INSERT INTO agent_schedule_operations
           (family_id, operation_key, operation_kind, input_hash, schedule_id)
         VALUES ($1, $2, 'run_now', $3, $4)`,
        [auth.familyId, operationKey, inputHash, id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'agent_schedule.run_now', $3, '{}'::jsonb)`,
        [auth.familyId, auth.userId, id],
      );
      await client.query("COMMIT");
      return rowToAgentSchedule(updated.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
