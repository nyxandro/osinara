/**
 * Telegram durable session actor validation tests.
 *
 * Constructs covered:
 * - Explicit Telegram user, bot, and channel auth recover their exact actor identity.
 * - Sessions without the deployed actor contract are intentionally invalidated.
 * - Channel identity cannot be projected through a user principal or Telegram user attribute.
 */
import type { SessionAuth } from "../runtime/context.js";
import { describe, expect, it } from "vitest";

import { resolveTelegramSessionActor } from "./telegram-session-actor.js";

function auth(current: Record<string, unknown>): SessionAuth {
  return { current, initiator: current } as unknown as SessionAuth;
}

describe("resolveTelegramSessionActor", () => {
  it("resolves an explicit Telegram user actor", () => {
    expect(resolveTelegramSessionActor(auth({
      attributes: {
        telegramActorId: "101",
        telegramActorKind: "telegram_user",
        telegramUserId: "101",
      },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    }))).toEqual({ id: "101", kind: "telegram_user" });
  });

  it("resolves an exact Telegram channel service actor", () => {
    expect(resolveTelegramSessionActor(auth({
      attributes: {
        telegramActorId: "-1001783384254",
        telegramActorKind: "telegram_channel",
      },
      authenticator: "telegram",
      principalId: "telegram-channel:-1001783384254",
      principalType: "service",
    }))).toEqual({ id: "-1001783384254", kind: "telegram_channel" });
  });

  it("resolves an exact Telegram bot service actor", () => {
    expect(resolveTelegramSessionActor(auth({
      attributes: {
        telegramActorId: "8123456789",
        telegramActorKind: "telegram_bot",
        telegramUserId: "8123456789",
      },
      authenticator: "telegram",
      principalId: "telegram-bot:8123456789",
      principalType: "service",
    }))).toEqual({ id: "8123456789", kind: "telegram_bot" });
  });

  it.each([
    { label: "a human principal type", principalType: "user" },
    { label: "a channel-shaped principal id", principalId: "telegram-channel:-1001783384254" },
    { label: "a negative actor id", actorId: "-8123456789" },
    { label: "a mismatched Telegram user attribute", telegramUserId: "999" },
    { label: "no Telegram user attribute", telegramUserId: null },
  ])("rejects a bot session carrying $label", (override) => {
    const actorId = override.actorId ?? "8123456789";
    expect(resolveTelegramSessionActor(auth({
      attributes: {
        telegramActorId: actorId,
        telegramActorKind: "telegram_bot",
        ...(override.telegramUserId === null
          ? {}
          : { telegramUserId: override.telegramUserId ?? actorId }),
      },
      authenticator: "telegram",
      principalId: override.principalId ?? `telegram-bot:${actorId}`,
      principalType: override.principalType ?? "service",
    }))).toBeNull();
  });

  it("invalidates a session that has only the former Telegram user attribute", () => {
    expect(resolveTelegramSessionActor(auth({
      attributes: { telegramUserId: "101" },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    }))).toBeNull();
  });

  it.each([
    { principalType: "user", telegramUserId: undefined },
    { principalType: "service", telegramUserId: "101" },
  ])("rejects a channel with conflicting principal shape", ({ principalType, telegramUserId }) => {
    expect(resolveTelegramSessionActor(auth({
      attributes: {
        telegramActorId: "-1001783384254",
        telegramActorKind: "telegram_channel",
        ...(telegramUserId === undefined ? {} : { telegramUserId }),
      },
      authenticator: "telegram",
      principalId: "telegram-channel:-1001783384254",
      principalType,
    }))).toBeNull();
  });
});
