/**
 * External-group reminder authorization derived from verified Eve Telegram session auth.
 *
 * Exports:
 * - `GroupReminderAuthorization`: trusted Telegram author and current group destination.
 * - `requireGroupReminderAuthorization`: rejects trusted, malformed and channel-authored contexts.
 *
 * Key construct:
 * - A participant of an external group has no account in this application, so the only durable
 *   author identity is the Telegram user id. A channel speaks for no person, so a record cannot be
 *   stored against it at all.
 * - Group-scoped proactive delivery is chat-level by contract, so no forum topic is carried here.
 */
import type { SessionContext } from "../../runtime/context.js";

import { AppError } from "../app-error.js";
import { resolveConversationEnvironment } from "../conversation-environment.js";
import { resolveSessionCaller } from "../session-auth.js";
import { resolveTelegramSessionActor } from "../telegram-session-actor.js";

export interface GroupReminderAuthorization {
  familyId: string;
  groupId: string;
  telegramChatId: string;
  telegramUserId: string;
}

const CONTEXT_ERROR_CODE = "AGENT_REMINDER_GROUP_CONTEXT_INVALID";

export function requireGroupReminderAuthorization(
  ctx: Pick<SessionContext, "session">,
): GroupReminderAuthorization {
  // The shared projection validates the complete auth shape, so this boundary never re-derives it.
  if (resolveConversationEnvironment(ctx.session.auth) !== "external") {
    throw new AppError(
      CONTEXT_ERROR_CODE,
      "Напоминание этого чата можно создать только в подключённой группе",
    );
  }
  // A group reminder belongs to the chat; its author is only provenance, and a bot participant
  // has a Telegram id that can carry it. A channel has none, so only that case stays refused.
  const actor = resolveTelegramSessionActor(ctx.session.auth);
  if (actor === null || actor.kind === "telegram_channel") {
    throw new AppError(
      "AGENT_REMINDER_AUTHOR_UNIDENTIFIED",
      "Это сообщение отправлено от имени канала, поэтому напоминание не к кому привязать. " +
        "Попросите создать его от своего имени",
    );
  }
  const attributes = resolveSessionCaller(ctx)?.attributes;
  const familyId = attributes?.familyId;
  const groupId = attributes?.groupId;
  const telegramChatId = attributes?.telegramChatId;
  if (
    typeof familyId !== "string" || typeof groupId !== "string" ||
    typeof telegramChatId !== "string"
  ) {
    throw new AppError(
      CONTEXT_ERROR_CODE,
      "Не удалось определить группу и чат для напоминания. Отправьте сообщение ещё раз",
    );
  }
  return { familyId, groupId, telegramChatId, telegramUserId: actor.id };
}
