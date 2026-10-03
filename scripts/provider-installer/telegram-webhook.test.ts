/**
 * Telegram webhook registration tests.
 *
 * Constructs covered:
 * - `configureTelegramWebhook`: registers and verifies one exact HTTPS webhook target.
 * - Token-safe URL construction, bounded requests, and strict Telegram state confirmation.
 */
import { describe, expect, it, vi } from "vitest";

import { configureTelegramWebhook } from "./telegram-webhook.js";

describe("configureTelegramWebhook", () => {
  it("sets and verifies the exact Osinara webhook without dropping queued updates", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: {
          has_custom_certificate: false,
          pending_update_count: 0,
          url: "https://bot.example.com/v1/telegram",
        },
      }), { headers: { "content-type": "application/json" } }));

    await expect(configureTelegramWebhook({
      fetch,
      hostname: "bot.example.com",
      secretToken: "webhook_secret-123",
      timeoutMs: 30_000,
      token: "123456:Abc_def-123",
    })).resolves.toBeUndefined();

    const firstUrl = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(firstUrl.pathname).toBe("/bot123456:Abc_def-123/setWebhook");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      allowed_updates: ["message", "callback_query"],
      secret_token: "webhook_secret-123",
      url: "https://bot.example.com/v1/telegram",
    });
    expect(body).not.toHaveProperty("drop_pending_updates");
    expect(String(fetch.mock.calls[1]?.[0])).toContain("/getWebhookInfo");
  });

  it("fails when Telegram does not confirm the exact target", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { has_custom_certificate: false, pending_update_count: 0, url: "" },
      })));

    await expect(configureTelegramWebhook({
      fetch,
      hostname: "bot.example.com",
      secretToken: "webhook_secret-123",
      timeoutMs: 30_000,
      token: "123456:Abc_def-123",
    })).rejects.toMatchObject({ code: "OSINARA_INSTALL_TELEGRAM_WEBHOOK_VERIFY_FAILED" });
  });

  it("does not expose a Telegram transport failure in the user-facing error", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("request URL contains bot token"));

    await expect(configureTelegramWebhook({
      fetch,
      hostname: "bot.example.com",
      secretToken: "webhook_secret-123",
      timeoutMs: 30_000,
      token: "123456:Abc_def-123",
    })).rejects.toMatchObject({
      code: "OSINARA_INSTALL_TELEGRAM_WEBHOOK_REQUEST_FAILED",
      message: expect.not.stringContaining("123456:Abc_def-123"),
    });
  });
});
