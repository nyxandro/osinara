/**
 * Telegram reaction delivery tests.
 *
 * Constructs covered:
 * - `setTelegramMessageReaction`: exact current-message Bot API request.
 * - Provider rejection and malformed acknowledgements fail with stable application errors.
 */
import type { TelegramHandle } from "../runtime/telegram/channel-types.js";
import { describe, expect, it, vi } from "vitest";

import { setTelegramMessageReaction } from "./telegram-message-reaction.js";

function telegramHandle(response: unknown, ok = true) {
  const request = vi.fn().mockResolvedValue({ body: response, ok, status: ok ? 200 : 400 });
  return {
    request,
    telegram: {
      chatId: "-100123",
      request,
    } as unknown as TelegramHandle,
  };
}

describe("setTelegramMessageReaction", () => {
  it("sets one small allowlisted reaction on the verified current message", async () => {
    const target = telegramHandle({ ok: true, result: true });

    await expect(
      setTelegramMessageReaction(target.telegram, "42", "👌"),
    ).resolves.toBe("applied");
    expect(target.request).toHaveBeenCalledWith("setMessageReaction", {
      chat_id: "-100123",
      is_big: false,
      message_id: 42,
      reaction: [{ emoji: "👌", type: "emoji" }],
    });
  });

  it("delivers an expressive allowlisted reaction without changing the transport shape", async () => {
    const target = telegramHandle({ ok: true, result: true });

    await expect(
      setTelegramMessageReaction(target.telegram, "43", "🔥"),
    ).resolves.toBe("applied");
    expect(target.request).toHaveBeenCalledWith("setMessageReaction", {
      chat_id: "-100123",
      is_big: false,
      message_id: 43,
      reaction: [{ emoji: "🔥", type: "emoji" }],
    });
  });

  it("rejects an invalid inbound message id before calling Telegram", async () => {
    const target = telegramHandle({ ok: true, result: true });

    await expect(setTelegramMessageReaction(target.telegram, "message-42", "👍"))
      .rejects.toThrowError(/AGENT_TELEGRAM_REACTION_TARGET_INVALID/u);
    expect(target.request).not.toHaveBeenCalled();
  });

  it("keeps a provider-declined reaction silent and reports it as unavailable", async () => {
    const target = telegramHandle({ description: "reaction not allowed", ok: false }, false);

    await expect(setTelegramMessageReaction(target.telegram, "42", "👎"))
      .resolves.toBe("unavailable");
  });

  it.each([{ body: { ok: true, result: false }, ok: true }, { body: null, ok: true }])(
    "fails closed when Telegram returns a malformed acknowledgement",
    async ({ body, ok }) => {
      const target = telegramHandle(body, ok);

      await expect(setTelegramMessageReaction(target.telegram, "42", "👎"))
        .rejects.toThrowError(/AGENT_TELEGRAM_REACTION_DELIVERY_FAILED/u);
    },
  );

  it("adds the stable delivery code to a transport failure and rethrows it", async () => {
    const error = new TypeError("fetch failed");
    const request = vi.fn().mockRejectedValue(error);
    const telegram = { chatId: "-100123", request } as unknown as TelegramHandle;

    await expect(setTelegramMessageReaction(telegram, "42", "👍"))
      .rejects.toBe(error);
    expect(error.message).toContain("AGENT_TELEGRAM_REACTION_DELIVERY_FAILED");
  });
});
