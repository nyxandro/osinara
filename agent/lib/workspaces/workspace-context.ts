/**
 * Trusted workspace authorization context.
 *
 * Export:
 * - `requireWorkspaceAuthorization`: derives scope identity only from verified session auth.
 * - `requireTelegramDeliveryTarget`: resolves only the current verified chat and topic.
 */
import type { SessionContext } from "../../runtime/context.js";

import { AppError } from "../app-error.js";
import { resolveSessionCaller } from "../session-auth.js";
import { resolveTelegramSessionActor } from "../telegram-session-actor.js";
import type { WorkspaceAuthorization } from "./workspace-repository.js";

export function requireWorkspaceAuthorization(
  ctx: { readonly session: Pick<SessionContext["session"], "auth"> },
): WorkspaceAuthorization {
  const caller = resolveSessionCaller(ctx) ?? ctx.session.auth.current;
  const attributes = caller?.attributes;
  const role = attributes?.role;
  const chatType = attributes?.telegramChatType;
  // Accountless participants use the same group workspace, never personal or family mounts.
  const externalParticipant = caller?.principalType === "service" &&
    resolveTelegramSessionActor(ctx.session.auth) !== null &&
    attributes?.groupType === "external" && role === "external" &&
    typeof attributes.groupId === "string" && attributes.groupId.length > 0 &&
    (chatType === "group" || chatType === "supergroup") &&
    Array.isArray(attributes.memoryScopes) && attributes.memoryScopes.length === 1 &&
    attributes.memoryScopes[0] === "group";
  if (
    caller?.authenticator !== "telegram" ||
    (caller.principalType !== "user" && !externalParticipant) ||
    typeof attributes?.familyId !== "string" ||
    !["group", "private", "supergroup"].includes(String(chatType)) ||
    !["external", "member", "owner", "recovery_owner"].includes(String(role))
  ) {
    throw new AppError(
      "AGENT_WORKSPACE_CONTEXT_INVALID",
      "Не удалось определить область доступа к файлам",
    );
  }
  return {
    familyId: attributes.familyId,
    groupId: typeof attributes.groupId === "string" ? attributes.groupId : null,
    groupType: ["external", "family_private"].includes(
      String(attributes.groupType),
    )
      ? attributes.groupType as WorkspaceAuthorization["groupType"]
      : null,
    role: role as WorkspaceAuthorization["role"],
    telegramChatType: chatType as WorkspaceAuthorization["telegramChatType"],
    userId: role === "external" ? null : caller.principalId,
  };
}

export function requireTelegramDeliveryTarget(
  ctx: Pick<SessionContext, "session">,
): { chatId: string; messageThreadId?: number } {
  const caller = resolveSessionCaller(ctx) ?? ctx.session.auth.current;
  const chatId = caller?.attributes.telegramChatId;
  const rawThreadId = caller?.attributes.telegramMessageThreadId;
  if (caller?.authenticator !== "telegram" || typeof chatId !== "string") {
    throw new AppError(
      "AGENT_TELEGRAM_DELIVERY_TARGET_INVALID",
      "Не удалось определить Telegram-чат для отправки файла",
    );
  }
  if (rawThreadId === undefined) return { chatId };
  const messageThreadId = Number(rawThreadId);
  if (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0) {
    throw new AppError(
      "AGENT_TELEGRAM_DELIVERY_TARGET_INVALID",
      "Не удалось определить тему Telegram для отправки файла",
    );
  }
  return { chatId, messageThreadId };
}
