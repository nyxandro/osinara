/**
 * Execution-time authorization for scheduled Telegram delivery.
 *
 * Exports:
 * - `AgentScheduleExecutionAuthorizationInput`: trusted run and destination identity for any tool.
 * - `AgentScheduleDeliveryAuthorizationInput`: trusted run and destination identity.
 * - `authorizeAgentScheduleExecution`: revalidates owner authority for scheduled tool execution.
 * - `isAgentScheduleDeliveryAuthorized`: transaction-composable live authorization predicate.
 * - `authorizeAgentScheduleDelivery`: revalidates the active run, membership, and trust zone.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { AgentScheduleScope } from "./agent-schedule-record.js";

export interface AgentScheduleExecutionAuthorizationInput {
  applicationSessionId: string;
  familyId: string;
  groupId: string | null;
  messageThreadId: string | null;
  ownerUserId: string | null;
  runId: string;
  scope: AgentScheduleScope;
  telegramChatId: string;
}

export interface AgentScheduleDeliveryAuthorizationInput
  extends AgentScheduleExecutionAuthorizationInput {
  agentSessionId: string;
}

async function isAuthorized(
  client: Pick<PoolClient, "query">,
  input: AgentScheduleExecutionAuthorizationInput,
  agentSessionId: string | null,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM agent_schedule_runs AS run
       JOIN agent_schedules AS schedule ON schedule.id = run.schedule_id
       JOIN family_memberships AS membership
         ON membership.family_id = schedule.family_id
        AND membership.user_id = schedule.author_user_id
       LEFT JOIN telegram_groups AS telegram_group
         ON telegram_group.id = schedule.group_id
        AND telegram_group.family_id = schedule.family_id
      WHERE run.id = $1 AND run.application_session_id = $2
        AND ($3::text IS NULL OR run.agent_session_id = $3)
        AND run.status = 'running' AND schedule.status = 'leased'
        AND schedule.family_id = $4 AND schedule.scope = $5
        AND schedule.group_id IS NOT DISTINCT FROM $6::uuid
        AND schedule.owner_user_id IS NOT DISTINCT FROM $7::uuid
        AND schedule.telegram_chat_id = $8
        AND schedule.message_thread_id IS NOT DISTINCT FROM $9::bigint
        AND (
          (schedule.scope = 'personal' AND schedule.owner_user_id = schedule.author_user_id) OR
          (schedule.scope = 'family' AND telegram_group.type = 'family_private'
            AND telegram_group.telegram_chat_id = schedule.telegram_chat_id) OR
          (schedule.scope = 'group' AND membership.role = 'owner'
            AND telegram_group.type = 'external'
            AND telegram_group.telegram_chat_id = schedule.telegram_chat_id
            AND telegram_group.telegram_chat_type = schedule.telegram_chat_type)
        )`,
    [
      input.runId,
      input.applicationSessionId,
      agentSessionId,
      input.familyId,
      input.scope,
      input.groupId,
      input.ownerUserId,
      input.telegramChatId,
      input.messageThreadId,
    ],
  );
  return result.rowCount === 1;
}

export async function isAgentScheduleDeliveryAuthorized(
  client: Pick<PoolClient, "query">,
  input: AgentScheduleDeliveryAuthorizationInput,
): Promise<boolean> {
  return await isAuthorized(client, input, input.agentSessionId);
}

export async function authorizeAgentScheduleExecution(
  input: AgentScheduleExecutionAuthorizationInput,
): Promise<void> {
  if (!await isAuthorized(database(), input, null)) {
    throw new AppError(
      "AGENT_SCHEDULE_EXECUTION_AUTHORIZATION_REVOKED",
      "Автоматизация остановлена: владелец или целевая Telegram-группа больше не авторизованы",
    );
  }
}

export async function authorizeAgentScheduleDelivery(
  input: AgentScheduleDeliveryAuthorizationInput,
): Promise<void> {
  // This query is the authorization linearization point immediately before Telegram side effects.
  if (!await isAgentScheduleDeliveryAuthorized(database(), input)) {
    throw new AppError(
      "AGENT_SCHEDULE_DELIVERY_AUTHORIZATION_REVOKED",
      "Доставка результата отменена: владелец или целевая Telegram-группа больше не авторизованы",
    );
  }
}
