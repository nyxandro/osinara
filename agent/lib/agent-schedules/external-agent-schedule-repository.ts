/**
 * Owner-private CRUD boundary for external-group scheduled automations.
 *
 * Exports:
 * - `ExternalAgentScheduleAuthorization`: verified owner identity from the current private chat.
 * - `externalAgentScheduleRepository`: owner-only create/list/update/lifecycle operations.
 *
 * Key constructs:
 * - Group identity and Telegram chat type are resolved from the current registered-group row.
 * - Persisted capabilities must be both schedule-safe and currently granted to the target group.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { parseExternalGroupToolAllowlist } from "../tool-policy/group-tool-catalog.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import { agentScheduleRepository } from "./agent-schedule-repository.js";
import { recurrenceValues } from "./agent-schedule-recurrence.js";
import {
  type AgentScheduleRow,
  agentScheduleOperationHash,
  rowToAgentSchedule,
} from "./agent-schedule-record.js";
import {
  agentScheduleColumns,
  findAgentScheduleOperation,
  lockAgentScheduleOperation,
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
  type ExternalScheduleCapability,
  parseExternalScheduleCapabilities,
} from "./external-agent-schedule-policy.js";

const HISTORY_WINDOW_MAX_DAYS = 365;
type QueryClient = Pick<PoolClient, "query">;

export interface ExternalAgentScheduleAuthorization {
  familyId: string;
  requestedBy: string;
}

interface ExternalScheduleGroupRow {
  id: string;
  telegram_chat_id: string;
  telegram_chat_type: "group" | "supergroup" | null;
  title: string;
  tool_allowlist: string[];
}

interface ExternalScheduleStatusRow extends AgentScheduleRow {
  history_window_days: number | null;
  telegram_chat_id: string;
  telegram_group_title: string;
  tool_allowlist: string[];
}

interface CreateExternalScheduleInput {
  capabilityAllowlist: ExternalScheduleCapability[];
  firstRunAt: Date;
  historyWindowDays?: number;
  operationKey: string;
  recurrence: AgentScheduleInputRecurrence;
  scenarioPrompt: string;
  telegramChatId: string;
  timezone: string;
  title: string;
  userRequest: string;
}

interface UpdateExternalScheduleInput {
  capabilityAllowlist?: ExternalScheduleCapability[];
  historyWindowDays?: number | null;
  nextRunAt?: Date;
  operationKey: string;
  recurrence?: AgentScheduleInputRecurrence;
  scenarioPrompt?: string;
  title?: string;
  userRequest?: string;
}

function ownerContext(auth: ExternalAgentScheduleAuthorization): AgentScheduleAuthorization {
  return {
    familyId: auth.familyId,
    forumTopicId: null,
    groupId: null,
    groupType: null,
    messageThreadId: null,
    role: "owner",
    telegramChatId: "owner-private",
    telegramChatType: "private",
    telegramUserId: "owner-private",
    userId: auth.requestedBy,
  };
}

async function requireCurrentOwner(
  client: PoolClient,
  auth: ExternalAgentScheduleAuthorization,
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM family_memberships
      WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
      FOR SHARE`,
    [auth.familyId, auth.requestedBy],
  );
  if (result.rowCount !== 1) {
    throw new AppError(
      "AGENT_OWNER_REQUIRED",
      "Управление автоматизациями внешних групп доступно только текущему владельцу в личном чате",
    );
  }
}

async function requireExternalGroup(
  client: PoolClient,
  auth: ExternalAgentScheduleAuthorization,
  telegramChatId: string,
): Promise<ExternalScheduleGroupRow> {
  const result = await client.query<ExternalScheduleGroupRow>(
    `SELECT id, telegram_chat_id, telegram_chat_type, title, tool_allowlist
       FROM telegram_groups
      WHERE family_id = $1 AND telegram_chat_id = $2 AND type = 'external'
      FOR SHARE`,
    [auth.familyId, telegramChatId],
  );
  const group = result.rows[0];
  if (!group) {
    throw new AppError(
      "AGENT_EXTERNAL_SCHEDULE_GROUP_NOT_FOUND",
      "Внешняя Telegram-группа не зарегистрирована. Сначала проверьте список групп",
    );
  }
  if (group.telegram_chat_type === null) {
    throw new AppError(
      "AGENT_EXTERNAL_SCHEDULE_CHAT_TYPE_UNKNOWN",
      "Тип Telegram-группы ещё не подтверждён. Отправьте в неё сообщение и повторите создание",
    );
  }
  return group;
}

function requireHistoryWindowDays(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > HISTORY_WINDOW_MAX_DAYS) {
    throw new AppError(
      "AGENT_EXTERNAL_SCHEDULE_HISTORY_WINDOW_INVALID",
      `historyWindowDays должен быть целым числом от 1 до ${HISTORY_WINDOW_MAX_DAYS}`,
    );
  }
  return value;
}

function requireCapabilitySubset(
  requested: unknown,
  groupAllowlist: unknown,
): ExternalScheduleCapability[] {
  const scheduled = parseExternalScheduleCapabilities(requested);
  const currentGroup = parseExternalGroupToolAllowlist(groupAllowlist);
  if (!scheduled || !currentGroup) {
    throw new AppError(
      "AGENT_EXTERNAL_SCHEDULE_CAPABILITIES_INVALID",
      "Не удалось проверить полный список возможностей автоматизации",
    );
  }
  for (const capability of scheduled) {
    if (!currentGroup.has(capability)) {
      throw new AppError(
        "AGENT_EXTERNAL_SCHEDULE_CAPABILITY_NOT_GRANTED",
        `В целевой группе сейчас не разрешена capability ${capability}`,
      );
    }
  }
  return [...scheduled];
}

function status(row: ExternalScheduleStatusRow) {
  return {
    ...rowToAgentSchedule(row),
    capabilityAllowlist: [...row.tool_allowlist],
    historyWindowDays: row.history_window_days,
    telegramChatId: row.telegram_chat_id,
    telegramGroupTitle: row.telegram_group_title,
  };
}

async function findStatus(
  auth: ExternalAgentScheduleAuthorization,
  id: string,
  client: QueryClient = database(),
): Promise<ReturnType<typeof status>> {
  const result = await client.query<ExternalScheduleStatusRow>(
    `SELECT ${agentScheduleColumns("schedule")}, schedule.telegram_chat_id,
            telegram_group.title AS telegram_group_title
       FROM agent_schedules AS schedule
       JOIN telegram_groups AS telegram_group ON telegram_group.id = schedule.group_id
      WHERE schedule.id = $3 AND schedule.family_id = $1 AND schedule.scope = 'group'
        AND EXISTS (
          SELECT 1 FROM family_memberships
           WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
        )`,
    [auth.familyId, auth.requestedBy, id],
  );
  if (!result.rows[0]) {
    throw new AppError(
      "AGENT_EXTERNAL_SCHEDULE_NOT_FOUND",
      "Автоматизация внешней группы не найдена",
    );
  }
  return status(result.rows[0]);
}

export const externalAgentScheduleRepository = {
  async create(auth: ExternalAgentScheduleAuthorization, input: CreateExternalScheduleInput) {
    const title = requireAgentScheduleTitle(input.title);
    const userRequest = requireAgentScheduleUserRequest(input.userRequest);
    const scenarioPrompt = requireAgentSchedulePrompt(input.scenarioPrompt);
    const firstRunAt = requireAgentScheduleDate(input.firstRunAt);
    const recurrence = requireAgentScheduleRecurrence(input.recurrence);
    const recurrenceValue = recurrenceValues(recurrence);
    const historyWindowDays = requireHistoryWindowDays(input.historyWindowDays);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentOwner(client, auth);
      const group = await requireExternalGroup(client, auth, input.telegramChatId);
      const capabilityAllowlist = requireCapabilitySubset(
        input.capabilityAllowlist,
        group.tool_allowlist,
      );
      const inputHash = agentScheduleOperationHash({
        ...input,
        capabilityAllowlist,
        firstRunAt: firstRunAt.toISOString(),
        historyWindowDays,
        recurrence,
      });
      // Serialize one family-scoped idempotency key before checking or inserting its operation row.
      await lockAgentScheduleOperation(client, ownerContext(auth), input.operationKey);
      const replay = await findAgentScheduleOperation(
        client,
        ownerContext(auth),
        input.operationKey,
        "create",
        inputHash,
      );
      if (replay !== undefined) {
        if (replay === null) {
          throw new AppError(
            "AGENT_EXTERNAL_SCHEDULE_NOT_FOUND",
            "Автоматизация внешней группы уже была удалена",
          );
        }
        const existing = await findStatus(auth, replay, client);
        await client.query("COMMIT");
        return existing;
      }
      const timezone = await client.query(
        "SELECT 1 FROM pg_timezone_names WHERE name = $1",
        [input.timezone],
      );
      if (timezone.rowCount !== 1) {
        throw new AppError(
          "AGENT_TIMEZONE_INVALID",
          "Не удалось распознать часовой пояс. Укажите IANA timezone, например Europe/Moscow",
        );
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO agent_schedules
           (family_id, owner_user_id, author_user_id, group_id, scope, title,
            user_request, scenario_prompt, timezone, recurrence_kind,
            recurrence_interval, recurrence_days_of_week, recurrence_anchor_local, recurrence_anchor_at,
            next_run_at, telegram_chat_id, telegram_chat_type, message_thread_id,
            forum_topic_id, history_window_days, tool_allowlist)
         VALUES ($1, NULL, $2, $3, 'group', $4, $5, $6, $7, $8, $9, $10,
                 $11::timestamptz AT TIME ZONE $7, $11, $11, $12, $13, NULL, NULL, $14, $15)
         RETURNING id`,
        [
          auth.familyId,
          auth.requestedBy,
          group.id,
          title,
          userRequest,
          scenarioPrompt,
          input.timezone,
          recurrenceValue.kind,
          recurrenceValue.interval,
          recurrenceValue.daysOfWeek,
          firstRunAt,
          group.telegram_chat_id,
          group.telegram_chat_type,
          historyWindowDays,
          capabilityAllowlist,
        ],
      );
      const id = inserted.rows[0]!.id;
      await client.query(
        `INSERT INTO agent_schedule_operations
           (family_id, operation_key, operation_kind, input_hash, schedule_id)
         VALUES ($1, $2, 'create', $3, $4)`,
        [auth.familyId, input.operationKey, inputHash, id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'agent_schedule.created', $3,
                 jsonb_build_object('scope', 'group', 'historyWindowDays', $4::int))`,
        [auth.familyId, auth.requestedBy, id, historyWindowDays],
      );
      const created = await findStatus(auth, id, client);
      await client.query("COMMIT");
      return created;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async list(input: ExternalAgentScheduleAuthorization & { telegramChatId: string | null }) {
    const result = await database().query<ExternalScheduleStatusRow>(
      `SELECT ${agentScheduleColumns("schedule")}, schedule.telegram_chat_id,
              telegram_group.title AS telegram_group_title
         FROM agent_schedules AS schedule
         JOIN telegram_groups AS telegram_group ON telegram_group.id = schedule.group_id
        WHERE schedule.family_id = $1 AND schedule.scope = 'group'
          AND ($3::text IS NULL OR schedule.telegram_chat_id = $3)
          AND EXISTS (
            SELECT 1 FROM family_memberships
             WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
          )
        ORDER BY schedule.created_at DESC, schedule.id DESC`,
      [input.familyId, input.requestedBy, input.telegramChatId],
    );
    return { items: result.rows.map(status), total: result.rows.length };
  },

  async update(
    auth: ExternalAgentScheduleAuthorization,
    id: string,
    input: UpdateExternalScheduleInput,
  ) {
    await agentScheduleRepository.update(ownerContext(auth), id, {
      ...input,
      requiredScope: "group",
    });
    return await findStatus(auth, id);
  },

  async delete(auth: ExternalAgentScheduleAuthorization, id: string, operationKey: string) {
    return await agentScheduleRepository.delete(ownerContext(auth), id, operationKey, "group");
  },

  async runNow(auth: ExternalAgentScheduleAuthorization, id: string, operationKey: string) {
    await agentScheduleRepository.runNow(ownerContext(auth), id, operationKey, "group");
    return await findStatus(auth, id);
  },

  async setEnabled(
    auth: ExternalAgentScheduleAuthorization,
    id: string,
    enabled: boolean,
    operationKey: string,
  ) {
    await agentScheduleRepository.update(ownerContext(auth), id, {
      enabled,
      operationKey,
      requiredScope: "group",
    });
    return await findStatus(auth, id);
  },
};
