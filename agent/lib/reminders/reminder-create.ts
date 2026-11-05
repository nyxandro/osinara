/**
 * Creating a personal or family reminder, or a wait for the person's timezone (#451).
 *
 * Exports:
 * - `ReminderCreateRequest`: a validated request with its first run named one of three ways.
 * - `ReminderCreateOutcome`: the reminder, or the wait when the clock time needs a zone nobody named.
 * - `createReminderOrWait`: one replay-safe transaction for both.
 *
 * With the person's timezone set, every way of naming the time becomes a reminder in that zone. Without
 * it, a countdown, alone or repeating by minutes or hours, is an exact moment and becomes a reminder in
 * UTC; a clock time becomes a wait; an exact moment with an offset is refused, because that offset
 * would be the model's guess of the zone.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { ReplyButtonRows } from "../reply-buttons/reply-button-contract.js";
import type { ReminderAuthorization } from "./reminder-context.js";
import { insertReminder } from "./reminder-insert.js";
import { type ReminderRecord, type ReminderRecurrence, reminderOperationHash, rowToReminder } from "./reminder-record.js";
import { findReminderOperation, requireCurrentMembership, selectReminder } from "./reminder-repository-helpers.js";
import { COUNTDOWN_TIMEZONE, countdownNeedsNoTimezone, type ReminderTimeInput } from "./reminder-time-input.js";
import {
  type AwaitingReminderRecord,
  findWaitReplay,
  insertWait,
  lockPersonReminders,
} from "./reminder-timezone-wait-repository.js";
import { requireReminderContent, requireReminderDate, requireReminderRecurrence } from "./reminder-validation.js";

export interface ReminderCreateRequest {
  /** Reply buttons sent with every delivery; absent for none. */
  buttons?: ReplyButtonRows;
  content: string;
  operationKey: string;
  recurrence: ReminderRecurrence | null;
  scope: "family" | "personal";
  time: ReminderTimeInput;
}

export type ReminderCreateOutcome =
  | { kind: "awaiting"; awaiting: AwaitingReminderRecord }
  | { kind: "reminder"; reminder: ReminderRecord };

function localTimeRequired(): AppError {
  return new AppError(
    "AGENT_REMINDER_LOCAL_TIME_REQUIRED",
    "Часовой пояс человека ещё не известен: передайте localFirstRun — время по его часам — или firstRunInMinutes для отсчёта от текущего момента",
  );
}

/**
 * The replay fingerprint. `JSON.stringify` keeps key order, so an exact moment is hashed in the order
 * the tool built it before #451 (buttons, content, firstRunAt, recurrence, scope, timezone,
 * operationKey): a create interrupted by a restart across the release still finds its reminder.
 */
export function createOperationHash(request: ReminderCreateRequest, content: string): string {
  const { time } = request;
  if (time.kind === "absolute") {
    return reminderOperationHash({
      ...(request.buttons === undefined ? {} : { buttons: request.buttons }),
      content,
      firstRunAt: time.at.toISOString(),
      recurrence: request.recurrence,
      scope: request.scope,
      timezone: time.timezone,
      operationKey: request.operationKey,
    });
  }
  const { time: _time, ...rest } = request;
  return reminderOperationHash({ ...rest, content, time });
}

async function requireDestination(client: Parameters<typeof requireCurrentMembership>[0], auth: ReminderAuthorization, personal: boolean) {
  if (personal && auth.telegramChatType !== "private") {
    throw new AppError("AGENT_REMINDER_DESTINATION_INVALID", "Личное напоминание можно создать только в личном чате");
  }
  if (!personal && (auth.groupType !== "family_private" || !auth.groupId)) {
    throw new AppError("AGENT_REMINDER_DESTINATION_INVALID", "Семейное напоминание создаётся в зарегистрированной семейной группе");
  }
  if (!personal) {
    const group = await client.query(
      `SELECT 1 FROM telegram_groups
       WHERE id = $1 AND family_id = $2 AND telegram_chat_id = $3 AND type = 'family_private'`,
      [auth.groupId, auth.familyId, auth.telegramChatId],
    );
    if (!group.rowCount) {
      throw new AppError("AGENT_REMINDER_DESTINATION_INVALID", "Семейная группа больше не зарегистрирована");
    }
  }
}

export async function createReminderOrWait(
  auth: ReminderAuthorization,
  request: ReminderCreateRequest,
  now: Date = new Date(),
): Promise<ReminderCreateOutcome> {
  const content = requireReminderContent(request.content);
  const recurrence = requireReminderRecurrence(request.recurrence);
  if (request.time.kind === "absolute") requireReminderDate(request.time.at);
  const inputHash = createOperationHash(request, content);
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await lockPersonReminders(client, auth.userId);
    await requireCurrentMembership(client, auth);
    const replayed = await findReminderOperation(client, auth.familyId, request.operationKey, "create", inputHash);
    if (replayed !== undefined) {
      if (!replayed) throw new AppError("AGENT_REMINDER_ALREADY_DELETED", "Это напоминание уже было создано и затем удалено");
      const existing = await selectReminder(client, auth.familyId, replayed);
      if (!existing) throw new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание уже удалено");
      await client.query("COMMIT");
      return { kind: "reminder", reminder: rowToReminder(existing) };
    }
    const waited = await findWaitReplay(client, auth.familyId, request.operationKey, inputHash);
    if (waited) {
      // A replay tells what became of the wait since: set, or no longer waiting.
      if (waited.status === "waiting") {
        await client.query("COMMIT");
        return { kind: "awaiting", awaiting: waited.record };
      }
      const set = waited.reminderId === null ? null : await selectReminder(client, auth.familyId, waited.reminderId);
      if (set) {
        await client.query("COMMIT");
        return { kind: "reminder", reminder: rowToReminder(set) };
      }
      throw new AppError(
        "AGENT_REMINDER_AWAITING_RESOLVED",
        "Это напоминание уже не ждёт часового пояса: проверьте актуальный список через manage_reminder с action=list",
      );
    }
    const personal = request.scope === "personal";
    await requireDestination(client, auth, personal);
    const settings = await client.query<{ timezone: string }>(
      "SELECT timezone FROM user_notification_settings WHERE user_id = $1",
      [auth.userId],
    );
    const timezone = settings.rows[0]?.timezone;
    const { time } = request;
    if (timezone === undefined && time.kind === "local") {
      const awaiting = await insertWait(client, {
        auth,
        buttons: request.buttons ?? null,
        content,
        inputHash,
        localFirstRun: time.local,
        now,
        operationKey: request.operationKey,
        recurrence,
        scope: request.scope,
      });
      await client.query("COMMIT");
      return { kind: "awaiting", awaiting };
    }
    if (timezone === undefined && (time.kind === "absolute" || !countdownNeedsNoTimezone(recurrence))) {
      throw localTimeRequired();
    }
    const named = time.kind === "absolute" ? time.timezone : time.statedTimezone;
    if (timezone !== undefined && named !== undefined && named !== timezone) {
      throw new AppError("AGENT_REMINDER_TIMEZONE_MISMATCH", `Подтвердите время в настроенном часовом поясе ${timezone}`);
    }
    let firstRunAt: Date;
    if (time.kind === "absolute") {
      firstRunAt = time.at;
    } else if (time.kind === "countdown") {
      firstRunAt = new Date(now.getTime() + time.minutes * 60_000);
    } else {
      const local = await client.query<{ at: Date }>("SELECT ($1::timestamp AT TIME ZONE $2) AS at", [time.local, timezone]);
      firstRunAt = local.rows[0]!.at;
    }
    const row = await insertReminder(client, {
      authorUserId: auth.userId,
      buttons: request.buttons ?? null,
      content,
      familyId: auth.familyId,
      firstRunAt,
      forumTopicId: personal ? null : auth.forumTopicId,
      groupId: personal ? null : auth.groupId,
      messageThreadId: personal ? null : auth.messageThreadId,
      ownerUserId: personal ? auth.userId : null,
      recurrence,
      scope: request.scope,
      telegramChatId: auth.telegramChatId,
      timezone: timezone ?? COUNTDOWN_TIMEZONE,
    }, { inputHash, operationKey: request.operationKey }, time.kind === "countdown" ? { time: "countdown" } : {});
    await client.query("COMMIT");
    return { kind: "reminder", reminder: rowToReminder(row) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
