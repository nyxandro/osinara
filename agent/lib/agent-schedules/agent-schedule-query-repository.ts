/**
 * Read-only personal and family agent schedule queries.
 *
 * Exports:
 * - `listAgentSchedules`: paginated schedules visible in trusted personal/family modes.
 * - `findAgentScheduleById`: one trusted personal/family schedule by opaque ID.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { decodeDateUuidCursor, encodeDateUuidCursor } from "../keyset-pagination.js";
import { AGENT_SCHEDULE_LIST_MAX_LIMIT } from "./agent-schedule-config.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import {
  type AgentScheduleRecord,
  type AgentScheduleRow,
  rowToAgentSchedule,
} from "./agent-schedule-record.js";
import { AGENT_SCHEDULE_COLUMNS } from "./agent-schedule-repository-helpers.js";
import { LAST_RUN_PROJECTION, rowToScheduleListItem, type ScheduleListItem, type ScheduleListRow } from "./agent-schedule-run-observation.js";

export async function listAgentSchedules(
  auth: AgentScheduleAuthorization,
  options: { cursor?: string; limit: number },
): Promise<{ items: ScheduleListItem[]; nextCursor: string | null }> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > AGENT_SCHEDULE_LIST_MAX_LIMIT) {
    throw new AppError("AGENT_SCHEDULE_LIMIT_INVALID", "Некорректный размер страницы расписаний");
  }
  const cursor = decodeDateUuidCursor(
    options.cursor,
    "AGENT_SCHEDULE_CURSOR_INVALID",
    "Не удалось продолжить просмотр агентных расписаний",
  );
  const result = await database().query<ScheduleListRow>(
    `SELECT ${AGENT_SCHEDULE_COLUMNS}, ${LAST_RUN_PROJECTION}
       FROM agent_schedules AS schedule
      WHERE schedule.family_id = $1
        AND EXISTS (
          SELECT 1 FROM family_memberships
           WHERE family_id = $1 AND user_id = $2
        )
        AND (
          (schedule.scope = 'personal' AND schedule.owner_user_id = $2) OR
          schedule.scope = 'family'
        )
        AND ($3::timestamptz IS NULL OR (schedule.created_at, schedule.id) < ($3, $4::uuid))
      ORDER BY schedule.created_at DESC, schedule.id DESC
      LIMIT $5`,
    [auth.familyId, auth.userId, cursor?.timestamp ?? null, cursor?.id ?? null, options.limit + 1],
  );
  const hasNext = result.rows.length > options.limit;
  const rows = result.rows.slice(0, options.limit);
  const last = rows.at(-1);
  return {
    items: rows.map(rowToScheduleListItem),
    nextCursor: hasNext && last ? encodeDateUuidCursor(last.created_at, last.id) : null,
  };
}

export async function findAgentScheduleById(
  auth: AgentScheduleAuthorization,
  id: string,
): Promise<AgentScheduleRecord | null> {
  const result = await database().query<AgentScheduleRow>(
    `SELECT ${AGENT_SCHEDULE_COLUMNS}
       FROM agent_schedules AS schedule
      WHERE schedule.id = $3 AND schedule.family_id = $1
        AND EXISTS (
          SELECT 1 FROM family_memberships
           WHERE family_id = $1 AND user_id = $2
        )
        AND (
          (schedule.scope = 'personal' AND schedule.owner_user_id = $2) OR
          schedule.scope = 'family'
        )`,
    [auth.familyId, auth.userId, id],
  );
  return result.rows[0] ? rowToAgentSchedule(result.rows[0]) : null;
}
