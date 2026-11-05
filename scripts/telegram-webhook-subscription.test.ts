/**
 * One-time update of the webhook subscription (#465).
 *
 * Constructs covered:
 * - The address and the secret are kept; every handled update type is subscribed; nothing is dropped.
 * - An already subscribed webhook is left alone.
 * - A server without a webhook, a refusal and an unconfirmed change fail with their codes.
 */
import { describe, expect, it, vi } from "vitest";

import { ensureTelegramWebhookSubscription } from "./telegram-webhook-subscription.js";

const URL = "https://bot.example.org/v1/telegram";

describe("ensureTelegramWebhookSubscription", () => {
  it("re-registers the same address and secret with every handled update type", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, result: { allowed_updates: ["message", "callback_query"], url: URL } })
      .mockResolvedValueOnce({ ok: true, result: true })
      .mockResolvedValueOnce({ ok: true, result: { allowed_updates: ["message", "callback_query", "my_chat_member"], url: URL } });

    await expect(ensureTelegramWebhookSubscription({ call, secretToken: "secret" })).resolves.toBe("subscribed");

    expect(call).toHaveBeenNthCalledWith(2, "setWebhook", {
      allowed_updates: ["message", "callback_query", "my_chat_member"],
      secret_token: "secret",
      url: URL,
    });
    expect(call.mock.calls[1]![1]).not.toHaveProperty("drop_pending_updates");
  });

  it("leaves an already subscribed webhook alone", async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true, result: { allowed_updates: ["callback_query", "message", "my_chat_member"], url: URL },
    });

    await expect(ensureTelegramWebhookSubscription({ call, secretToken: "secret" })).resolves.toBe("already_subscribed");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no webhook is set", [{ ok: true, result: { url: "" } }], "AGENT_TELEGRAM_WEBHOOK_NOT_SET"],
    ["Telegram refuses", [{ ok: true, result: { url: URL } }, { ok: false }], "AGENT_TELEGRAM_WEBHOOK_SET_FAILED"],
    ["the change is not confirmed", [
      { ok: true, result: { url: URL } }, { ok: true, result: true }, { ok: true, result: { allowed_updates: ["message"], url: URL } },
    ], "AGENT_TELEGRAM_WEBHOOK_VERIFY_FAILED"],
  ])("fails when %s", async (_case, answers, code) => {
    const call = vi.fn();
    for (const answer of answers) call.mockResolvedValueOnce(answer);

    await expect(ensureTelegramWebhookSubscription({ call, secretToken: "secret" })).rejects.toThrow(new RegExp(`^${code}:`, "u"));
  });
});
