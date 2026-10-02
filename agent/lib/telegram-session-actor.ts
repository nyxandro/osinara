/**
 * Telegram actor recovery from verified Eve session auth.
 *
 * Exports:
 * - `TelegramSessionActor`: normalized durable user, bot, or channel actor identity.
 * - `resolveTelegramSessionActor`: validates explicit durable user, bot, or channel attributes.
 * - `isTelegramChannelSession`: exact channel-service predicate for authorization boundaries.
 * - `accountlessActorApprovalError`: refusal for an actor that no human can answer for.
 */
import type { SessionAuth } from "../runtime/context.js";

import { AppError } from "./app-error.js";
import type { TelegramActorKind } from "./telegram-inbound-actor.js";

export interface TelegramSessionActor {
  id: string;
  kind: TelegramActorKind;
}

export function resolveTelegramSessionActor(auth: SessionAuth): TelegramSessionActor | null {
  const caller = auth.current;
  const attributes = caller?.attributes;
  if (!caller || !attributes) return null;
  const actorKind = attributes?.telegramActorKind;
  const actorId = attributes?.telegramActorId;

  if (actorKind === "telegram_channel") {
    const valid = caller.authenticator === "telegram" && caller.principalType === "service" &&
      typeof actorId === "string" && /^-[0-9]+$/u.test(actorId) &&
      attributes.telegramUserId === undefined && caller.principalId === `telegram-channel:${actorId}`;
    return valid ? { id: actorId, kind: actorKind } : null;
  }
  // A bot has a Telegram user id of its own and identifies itself with it, exactly like a person.
  // It owns no application account, so its principal stays the service identity it was admitted under.
  if (actorKind === "telegram_bot") {
    const valid = caller.authenticator === "telegram" && caller.principalType === "service" &&
      typeof actorId === "string" && /^[1-9]\d*$/u.test(actorId) &&
      attributes.telegramUserId === actorId && caller.principalId === `telegram-bot:${actorId}`;
    return valid ? { id: actorId, kind: actorKind } : null;
  }
  if (actorKind === "telegram_user") {
    const telegramUserId = attributes.telegramUserId;
    const valid = caller.principalType === "user" && typeof actorId === "string" &&
      actorId === telegramUserId;
    return valid ? { id: actorId, kind: actorKind } : null;
  }

  // Sessions without the explicit actor contract are intentionally invalidated at this boundary.
  return null;
}

export function isTelegramChannelSession(auth: SessionAuth): boolean {
  return resolveTelegramSessionActor(auth)?.kind === "telegram_channel";
}

/**
 * A confirmation is answered by the human who owns the account that asked for it. A channel and a
 * bot own none, so their turns must be refused at the boundary instead of parked for nobody.
 */
export function accountlessActorApprovalError(auth: SessionAuth): AppError | null {
  const actor = resolveTelegramSessionActor(auth);
  if (actor === null || actor.kind === "telegram_user") return null;
  return actor.kind === "telegram_channel"
    ? new AppError(
      "AGENT_TELEGRAM_CHANNEL_APPROVAL_FORBIDDEN",
      "Сообщение от имени канала не может подтверждать действия. Напишите от личного аккаунта",
    )
    : new AppError(
      "AGENT_TELEGRAM_BOT_APPROVAL_FORBIDDEN",
      "Сообщение от другого бота не может подтверждать действия. Напишите от личного аккаунта",
    );
}
