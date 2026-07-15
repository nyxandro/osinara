/**
 * PostgreSQL helpers for agent schedule CRUD and dispatcher repositories.
 *
 * Exports:
 * - Shared column projections and mutable row types.
 * - Membership, timezone, replay, row-lock, and mutation authorization helpers.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import type { AgentScheduleRow } from "./agent-schedule-record.js";

export interface MutableAgentScheduleRow extends AgentScheduleRow {
  author_user_id: string;
  family_id: string;
  group_id: string | null;
  occurrence_index: number;
  owner_user_id: string | null;
  recurrence_anchor_local: Date;
  telegram_chat_id: string;
  telegram_chat_type: "group" | "private" | "supergroup";
}

export const AGENT_SCHEDULE_COLUMNS = `id, scope, title, user_request, scenario_prompt,
  timezone, recurrence_kind, recurrence_interval, recurrence_days_of_week,
  next_run_at, status, message_thread_id::text, last_error_code, created_at, updated_at`;

export async function requireCurrentScheduleMembership(
  client: PoolClient,
  auth: AgentScheduleAuthorization,
): Promise<"member" | "owner" | "recovery_owner"> {
  const membership = await client.query<{ role: "member" | "owner" | "recovery_owner" }>(
    "SELECT role FROM family_memberships WHERE family_id = $1 AND user_id = $2",
    [auth.familyId, auth.userId],
  );
  const role = membership.rows[0]?.role;
  if (!role) {
    throw new AppError("AGENT_ACCESS_DENIED", "У вас больше нет доступа к этой семье");
  }
  return role;
}

export async function requireAgentScheduleTimezone(
  client: PoolClient,
  timezone: string,
): Promise<string> {
  const result = await client.query<{ name: string }>(
    "SELECT name FROM pg_timezone_names WHERE name = $1",
    [timezone],
  );
  if (!result.rows[0]) {
    throw new AppError(
      "AGENT_TIMEZONE_INVALID",
      "Не удалось распознать часовой пояс. Укажите название IANA, например Europe/Moscow",
    );
  }
  return result.rows[0].name;
}

export async function findAgentScheduleOperation(
  client: PoolClient,
  auth: AgentScheduleAuthorization,
  operationKey: string,
  operationKind: "create" | "delete" | "run_now" | "update",
  inputHash: string,
): Promise<string | null | undefined> {
  const result = await client.query<{
    input_hash: string;
    operation_kind: string;
    schedule_id: string | null;
  }>(
    `SELECT operation_kind, input_hash, schedule_id
     FROM agent_schedule_operations WHERE family_id = $1 AND operation_key = $2`,
    [auth.familyId, operationKey],
  );
  const operation = result.rows[0];
  if (!operation) return undefined;
  if (operation.operation_kind !== operationKind || operation.input_hash !== inputHash) {
    throw new AppError(
      "AGENT_SCHEDULE_OPERATION_CONFLICT",
      "Повтор операции агентного расписания содержит другие параметры",
    );
  }
  return operation.schedule_id;
}

export async function selectAgentSchedule(
  client: PoolClient,
  familyId: string,
  id: string,
  lock = false,
): Promise<MutableAgentScheduleRow | null> {
  const result = await client.query<MutableAgentScheduleRow>(
    `SELECT ${AGENT_SCHEDULE_COLUMNS}, family_id, owner_user_id, author_user_id,
            group_id, occurrence_index, recurrence_anchor_local,
            telegram_chat_id, telegram_chat_type
       FROM agent_schedules WHERE family_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [familyId, id],
  );
  return result.rows[0] ?? null;
}

export async function requireAgentScheduleMutationAccess(
  client: PoolClient,
  auth: AgentScheduleAuthorization,
  schedule: MutableAgentScheduleRow,
): Promise<void> {
  const role = await requireCurrentScheduleMembership(client, auth);
  const allowed = schedule.scope === "personal"
    ? schedule.author_user_id === auth.userId
    : schedule.author_user_id === auth.userId || role === "owner";
  if (!allowed) {
    throw new AppError(
      "AGENT_SCHEDULE_MUTATION_DENIED",
      "Изменить семейное агентное расписание может только его автор или владелец семьи",
    );
  }
}
