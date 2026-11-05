/**
 * Family administration context.
 *
 * Exports:
 * - `requireFamilyCaller`: validates a family-authenticated session.
 * - `isFamilyOwner`: whether the verified caller is the owner, for what a turn is offered.
 * - `requireOwner`: enforces owner-only administration.
 * - `requirePrivateTelegramOwner`: limits secret delivery to the verified owner chat.
 * - `requirePrivateTelegramMember`: a family member in their own private chat.
 */
import type { SessionAuth, SessionContext } from "../runtime/context.js";

import { AppError } from "./app-error.js";
import type { FamilyRole } from "./family-access.js";
import { resolveSessionCaller } from "./session-auth.js";

export interface FamilyCaller {
  familyId: string;
  role: FamilyRole;
  userId: string;
}

export interface PrivateTelegramOwner extends FamilyCaller {
  telegramChatId: string;
}

export function requireFamilyCaller(ctx: Pick<SessionContext, "session">): FamilyCaller {
  const caller = resolveSessionCaller(ctx);
  const familyId = caller?.attributes.familyId;
  const role = caller?.attributes.role;
  if (
    caller?.principalType !== "user" ||
    typeof familyId !== "string" ||
    !["member", "owner", "recovery_owner"].includes(String(role))
  ) {
    throw new AppError("AGENT_ACCESS_DENIED", "Требуется доступ члена семьи");
  }
  return { familyId, role: role as FamilyRole, userId: caller.principalId };
}

/**
 * Whether the verified caller of this turn is the family's owner. The tool surface and the mode block
 * offer the owner's administration only then; each of those tools still checks it at execution.
 */
export function isFamilyOwner(auth: SessionAuth): boolean {
  const caller = auth.current;
  return caller?.principalType === "user" && caller.attributes.role === "owner";
}

export function requireOwner(ctx: Pick<SessionContext, "session">): FamilyCaller {
  const caller = requireFamilyCaller(ctx);
  if (caller.role !== "owner") {
    throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
  }
  return caller;
}

export function requirePrivateTelegramOwner(ctx: Pick<SessionContext, "session">): PrivateTelegramOwner {
  const owner = requireOwner(ctx);
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  if (
    caller?.authenticator !== "telegram" ||
    attributes?.telegramChatType !== "private" ||
    typeof attributes.telegramChatId !== "string"
  ) {
    throw new AppError(
      "AGENT_PRIVATE_CHAT_REQUIRED",
      "Это действие доступно только в личном чате владельца с агентом",
    );
  }
  return { ...owner, telegramChatId: attributes.telegramChatId };
}

/** A family member in their own private chat with the agent, whatever their role. */
export function requirePrivateTelegramMember(ctx: Pick<SessionContext, "session">): FamilyCaller {
  const member = requireFamilyCaller(ctx);
  const attributes = resolveSessionCaller(ctx)?.attributes;
  if (resolveSessionCaller(ctx)?.authenticator !== "telegram" || attributes?.telegramChatType !== "private") {
    throw new AppError("AGENT_PRIVATE_CHAT_REQUIRED", "Скиллы семьи меняются только в личном чате с агентом");
  }
  return member;
}
