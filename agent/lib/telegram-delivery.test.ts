/**
 * Trusted Telegram delivery adapter tests.
 *
 * Constructs covered:
 * - `deliverFamilyInvitation`: sends the one-time link through Eve's Telegram API helper.
 * - Provider failures remain diagnosable and do not return secret data to the model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverFamilyInvitation } from "./telegram-delivery.js";

describe("deliverFamilyInvitation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends a deep link directly to the verified private chat", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "osinara_bot");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deliverFamilyInvitation({
        chatId: "owner-chat-1",
        code: "a".repeat(32),
        expiresAt: "2026-07-12T12:00:00.000Z",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-bot-secret/sendMessage",
      expect.objectContaining({
        headers: { "content-type": "application/json; charset=utf-8" },
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toEqual({
      chat_id: "owner-chat-1",
      text: [
        "Одноразовое приглашение в семейного агента:",
        "https://t.me/osinara_bot?start=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "Действует до 2026-07-12T12:00:00.000Z.",
      ].join("\n"),
    });
  });

  it("reports a stable error when Telegram rejects delivery", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "osinara_bot");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));

    await expect(
      deliverFamilyInvitation({
        chatId: "owner-chat-1",
        code: "a".repeat(32),
        expiresAt: "2026-07-12T12:00:00.000Z",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrowError(/AGENT_TELEGRAM_INVITATION_DELIVERY_FAILED/);
  });
});
