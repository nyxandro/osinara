/**
 * Reminder authorization derived from verified Eve Telegram session auth.
 *
 * Exports:
 * - `ReminderAuthorization`: trusted identity and current Telegram destination.
 * - `requireReminderAuthorization`: rejects app, external-group, and malformed contexts.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";
import { resolveSessionCaller } from "../session-auth.js";

export interface ReminderAuthorization {
  familyId: string;
  groupId: string | null;
  groupType: "family_private" | null;
  messageThreadId: string | null;
  role: "member" | "owner" | "recovery_owner";
  telegramChatId: string;
  telegramChatType: "group" | "private" | "supergroup";
  userId: string;
}

export function requireReminderAuthorization(
  ctx: Pick<SessionContext, "session">,
): ReminderAuthorization {
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  const role = attributes?.role;
  const chatType = attributes?.telegramChatType;
  if (
    caller?.principalType !== "user" ||
    caller.authenticator !== "telegram" ||
    typeof attributes?.familyId !== "string" ||
    typeof attributes.telegramChatId !== "string" ||
    !["group", "private", "supergroup"].includes(String(chatType)) ||
    !["member", "owner", "recovery_owner"].includes(String(role))
  ) {
    throw new AppError(
      "AGENT_REMINDER_CONTEXT_INVALID",
      "Не удалось определить пользователя и чат для напоминания",
    );
  }
  const groupType = attributes.groupType;
  const groupId = attributes.groupId;
  return {
    familyId: attributes.familyId,
    groupId: typeof groupId === "string" ? groupId : null,
    groupType: groupType === "family_private" ? groupType : null,
    messageThreadId: typeof attributes.telegramMessageThreadId === "string"
      ? attributes.telegramMessageThreadId
      : null,
    role: role as ReminderAuthorization["role"],
    telegramChatId: attributes.telegramChatId,
    telegramChatType: chatType as ReminderAuthorization["telegramChatType"],
    userId: caller.principalId,
  };
}
