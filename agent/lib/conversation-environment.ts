/**
 * Verified conversation-environment resolution.
 *
 * Exports:
 * - `ConversationEnvironment`: the three model-facing trust zones.
 * - `resolveConversationEnvironment`: validates current Telegram auth and selects one trust zone.
 *
 * Prompt text for each trust zone is composed separately in `prompt/mode-instructions.ts`, so this
 * module stays a pure authorization projection with no model-facing wording.
 */
import type { SessionAuth } from "../runtime/context.js";

import { AppError } from "./app-error.js";
import { resolveTelegramSessionActor } from "./telegram-session-actor.js";

export type ConversationEnvironment = "external" | "family" | "private";

const ENVIRONMENT_ERROR_CODE = "AGENT_CONVERSATION_ENVIRONMENT_INVALID";
const GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);

function scopesEqual(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  const scopes = new Set(value);
  return scopes.size === expected.length && expected.every((scope) => scopes.has(scope));
}

function environmentError(): AppError {
  return new AppError(
    ENVIRONMENT_ERROR_CODE,
    "Не удалось определить режим текущего чата. Отправьте сообщение ещё раз",
  );
}

export function resolveConversationEnvironment(auth: SessionAuth): ConversationEnvironment {
  const caller = auth.current;
  const attributes = caller?.attributes;
  const actor = resolveTelegramSessionActor(auth);
  if (
    !caller ||
    actor === null ||
    (caller.authenticator !== "telegram" && caller.authenticator !== "memory-review") ||
    !attributes
  ) {
    throw environmentError();
  }

  // A private turn has both personal and family scopes and no registered group type.
  const chatType = attributes.telegramChatType;
  const groupType = attributes.groupType;
  const memoryScopes = attributes.memoryScopes;
  const memoryReview = caller.authenticator === "memory-review";
  if (
    actor.kind === "telegram_user" &&
    chatType === "private" &&
    groupType === undefined &&
    scopesEqual(memoryScopes, ["personal", "family"])
  ) {
    return "private";
  }

  // Registered Telegram groups are distinguished by their persisted trust-zone type.
  if (actor.kind === "telegram_user" &&
    (memoryReview || GROUP_CHAT_TYPES.has(String(chatType))) && groupType === "family_private") {
    if (scopesEqual(memoryScopes, ["family"])) return "family";
    throw environmentError();
  }
  if (
    (memoryReview || GROUP_CHAT_TYPES.has(String(chatType))) &&
    groupType === "external" &&
    (actor.kind === "telegram_user" || (
      caller.principalType === "service" && attributes.role === "external"
    ))
  ) {
    if (scopesEqual(memoryScopes, ["group"])) return "external";
    throw environmentError();
  }

  throw environmentError();
}
