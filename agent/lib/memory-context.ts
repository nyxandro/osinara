/**
 * Memory authorization derived from Eve session auth.
 *
 * Exports:
 * - `MemoryAuthorization`: verified identity and scopes available to memory operations.
 * - `requireMemoryAuthorization`: validates framework session context.
 * - `requireWritableScope`: prevents model-selected scope escalation.
 */
import type { SessionContext } from "eve/context";
import type { DynamicResolveContext } from "eve/instructions";

import { AppError } from "./app-error.js";
import { resolveSessionCaller } from "./session-auth.js";
import type { TelegramActorKind } from "./telegram-inbound-actor.js";
import { resolveTelegramSessionActor } from "./telegram-session-actor.js";

export type MemoryScope = "family" | "group" | "personal";
export type MemoryRole = "external" | "member" | "owner" | "recovery_owner";

export interface MemoryAuthorization {
  familyId: string;
  groupId: string | null;
  role: MemoryRole;
  scopes: MemoryScope[];
  telegramActorId: string;
  telegramActorKind: TelegramActorKind;
  telegramUserId: string | null;
  userId: string | null;
}

type MemoryContext = Pick<DynamicResolveContext, "session"> | Pick<SessionContext, "session">;

export function requireMemoryAuthorization(ctx: MemoryContext): MemoryAuthorization {
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  const familyId = attributes?.familyId;
  const groupId = attributes?.groupId;
  const memoryScopes = attributes?.memoryScopes;
  const role = attributes?.role;
  const telegramUserId = attributes?.telegramUserId;
  const actor = resolveTelegramSessionActor(ctx.session.auth);

  if (
    actor === null ||
    typeof familyId !== "string" ||
    !["external", "member", "owner", "recovery_owner"].includes(String(role)) ||
    !Array.isArray(memoryScopes) ||
    !memoryScopes.every((scope) => ["family", "group", "personal"].includes(String(scope)))
  ) {
    throw new AppError(
      "AGENT_MEMORY_CONTEXT_INVALID",
      "Не удалось определить разрешенную область памяти",
    );
  }
  const groupIdValue = typeof groupId === "string" ? groupId : null;
  const channelShapeValid = actor.kind !== "telegram_channel" || (
    caller?.principalType === "service" && role === "external" && groupIdValue !== null &&
    memoryScopes.length === 1 && memoryScopes[0] === "group" && telegramUserId === undefined
  );
  const userShapeValid = actor.kind !== "telegram_user" || typeof telegramUserId === "string";
  if (!channelShapeValid || !userShapeValid) {
    throw new AppError(
      "AGENT_MEMORY_CONTEXT_INVALID",
      "Не удалось определить разрешенную область памяти",
    );
  }

  return {
    familyId,
    groupId: groupIdValue,
    role: role as MemoryRole,
    scopes: memoryScopes as MemoryScope[],
    telegramActorId: actor.id,
    telegramActorKind: actor.kind,
    telegramUserId: typeof telegramUserId === "string" ? telegramUserId : null,
    userId: role === "external" ? null : caller!.principalId,
  };
}

export function requireWritableScope(
  authorization: MemoryAuthorization,
  requestedScope: MemoryScope,
): MemoryScope {
  if (!authorization.scopes.includes(requestedScope)) {
    throw new AppError(
      "AGENT_MEMORY_SCOPE_DENIED",
      "Эта область памяти недоступна в текущем чате",
    );
  }
  if (requestedScope === "group" && !authorization.groupId) {
    throw new AppError(
      "AGENT_MEMORY_CONTEXT_INVALID",
      "Не удалось определить группу для сохранения памяти",
    );
  }
  return requestedScope;
}
