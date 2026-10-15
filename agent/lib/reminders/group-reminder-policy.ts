/**
 * External-group reminder rules shared by the repository operations.
 *
 * Exports:
 * - `reminderNotFound`: the refusal a participant receives for a record of another chat.
 * - `requireGroupReminderOfThisChat`: the only visibility boundary of a public chat reminder.
 * - `requireGroupReminderTime`: the accepted first-run window of a public chat.
 * - `requireGroupReminderDestination`: live registration of the verified current chat.
 * - `requireFreeGroupSlot`: the chat cap under one per-group lock.
 *
 * Key construct:
 * - A reminder of a public chat belongs to the chat, not to the person who dictated it: every
 *   participant sees, changes and removes any of them. The only boundary left is the chat itself,
 *   and the only quota is the shared one, so the rules stay in one place for all operations.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import type { GroupReminderAuthorization } from "./group-reminder-context.js";
import {
  GROUP_REMINDER_MAX_BACKDATE_MS,
  GROUP_REMINDER_MAX_PER_CHAT,
} from "./reminder-config.js";
import { type MutableReminderRow, REMINDER_LIVE_STATUSES } from "./reminder-repository-helpers.js";
import { requireReminderDate } from "./reminder-validation.js";

export function reminderNotFound(): AppError {
  return new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание не найдено");
}

/**
 * A reminder of another chat stays invisible rather than merely unchangeable: the participant must
 * not learn that it exists.
 */
export function requireGroupReminderOfThisChat(
  auth: GroupReminderAuthorization,
  reminder: Pick<MutableReminderRow, "group_id" | "scope">,
): void {
  if (reminder.scope !== "group" || reminder.group_id !== auth.groupId) throw reminderNotFound();
}

export function requireGroupReminderTime(firstRunAt: Date): Date {
  const validated = requireReminderDate(firstRunAt);
  if (validated.getTime() < Date.now() - GROUP_REMINDER_MAX_BACKDATE_MS) {
    throw new AppError(
      "AGENT_REMINDER_GROUP_TIME_TOO_OLD",
      "Это время уже прошло. Укажите время напоминания в будущем",
    );
  }
  return validated;
}

export async function requireGroupReminderDestination(
  client: PoolClient,
  auth: GroupReminderAuthorization,
): Promise<void> {
  const group = await client.query(
    `SELECT 1 FROM telegram_groups
     WHERE id = $1 AND family_id = $2 AND telegram_chat_id = $3 AND type = 'external'`,
    [auth.groupId, auth.familyId, auth.telegramChatId],
  );
  if (!group.rowCount) {
    throw new AppError(
      "AGENT_REMINDER_DESTINATION_INVALID",
      "Эта группа больше не подключена как внешняя, напоминание создать нельзя",
    );
  }
}

/**
 * The chat cap is enforced under one per-group lock, so counting and the write that follows it
 * cannot interleave with another participant. `excludeId` keeps a revived reminder from counting
 * itself when it is already live.
 */
export async function requireFreeGroupSlot(
  client: PoolClient,
  auth: GroupReminderAuthorization,
  excludeId: string | null,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('osinara-group-reminders:' || $1::text, 0))",
    [auth.groupId],
  );
  const counts = await client.query<{ total: string }>(
    `SELECT count(*) AS total
     FROM reminders
     WHERE scope = 'group' AND group_id = $1 AND status IN ${REMINDER_LIVE_STATUSES}
       AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [auth.groupId, excludeId],
  );
  if (Number(counts.rows[0]!.total) >= GROUP_REMINDER_MAX_PER_CHAT) {
    throw new AppError(
      "AGENT_REMINDER_GROUP_CHAT_LIMIT",
      `В этом чате уже стоит максимум напоминаний (${GROUP_REMINDER_MAX_PER_CHAT}). ` +
        "Удалите ненужное, чтобы поставить новое",
    );
  }
}
