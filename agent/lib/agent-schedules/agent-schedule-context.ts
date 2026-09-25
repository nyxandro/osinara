/**
 * Agent schedule authorization derived from verified Eve Telegram session auth.
 *
 * Exports:
 * - `AgentScheduleAuthorization`: trusted identity and current Telegram destination.
 * - `requireAgentScheduleAuthorization`: rejects app, external-group, and malformed contexts.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";
import { resolveSessionCaller } from "../session-auth.js";

export interface AgentScheduleAuthorization {
  /** Conversation of the current turn; a schedule that runs in the conversation binds to it. */
  applicationSessionId?: string;
  forumTopicId: string | null;
  familyId: string;
  groupId: string | null;
  groupType: "family_private" | null;
  messageThreadId: string | null;
  role: "member" | "owner" | "recovery_owner";
  telegramChatId: string;
  telegramChatType: "group" | "private" | "supergroup";
  /** Ingress update of the current turn; it names the chat queue a conversation run waits in. */
  telegramUpdateId?: string;
  telegramUserId: string;
  userId: string;
}

export function requireAgentScheduleAuthorization(
  ctx: Pick<SessionContext, "session">,
): AgentScheduleAuthorization {
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  const role = attributes?.role;
  const chatType = attributes?.telegramChatType;
  if (
    caller?.principalType !== "user" ||
    caller.authenticator !== "telegram" ||
    typeof attributes?.familyId !== "string" ||
    typeof attributes.telegramChatId !== "string" ||
    typeof attributes.telegramUserId !== "string" ||
    !["group", "private", "supergroup"].includes(String(chatType)) ||
    !["member", "owner", "recovery_owner"].includes(String(role))
  ) {
    throw new AppError(
      "AGENT_SCHEDULE_CONTEXT_INVALID",
      "Не удалось определить пользователя и чат для агентного расписания",
    );
  }

  // External groups deliberately have no scheduled-agent surface.
  const groupType = attributes.groupType;
  if (groupType === "external") {
    throw new AppError(
      "AGENT_SCHEDULE_SCOPE_DENIED",
      "Агентные расписания доступны только в личном чате и семейной группе",
    );
  }

  return {
    ...(typeof attributes.applicationSessionId === "string"
      ? { applicationSessionId: attributes.applicationSessionId }
      : {}),
    familyId: attributes.familyId,
    forumTopicId: typeof attributes.telegramForumTopicId === "string"
      ? attributes.telegramForumTopicId
      : null,
    groupId: typeof attributes.groupId === "string" ? attributes.groupId : null,
    groupType: groupType === "family_private" ? groupType : null,
    messageThreadId: typeof attributes.telegramMessageThreadId === "string"
      ? attributes.telegramMessageThreadId
      : null,
    role: role as AgentScheduleAuthorization["role"],
    telegramChatId: attributes.telegramChatId,
    telegramChatType: chatType as AgentScheduleAuthorization["telegramChatType"],
    ...(typeof attributes.osinaraTelegramUpdateId === "string"
      ? { telegramUpdateId: attributes.osinaraTelegramUpdateId }
      : {}),
    telegramUserId: attributes.telegramUserId,
    userId: caller.principalId,
  };
}
