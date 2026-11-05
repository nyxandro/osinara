/**
 * The verified Telegram webhook route.
 *
 * Constructs covered:
 * - A `my_chat_member` update goes to its own handler and never to the message ingress (#465).
 * - An update without the webhook secret reaches neither.
 */
import { describe, expect, it, vi } from "vitest";

import { telegramWebhookRoutes } from "./telegram-channel.js";

const SECRET = "webhook-secret";
const MEMBERSHIP = {
  chat: { id: -1001, type: "supergroup" },
  date: 1_762_300_000,
  new_chat_member: { status: "kicked", user: { id: 900, is_bot: true } },
};

function routes() {
  const onBotMembership = vi.fn(async () => undefined);
  const onVerifiedUpdate = vi.fn(async () => new Response("ok"));
  const [webhook] = telegramWebhookRoutes({
    drainRoute: "/drain",
    onBotMembership,
    onDrain: vi.fn(),
    onVerifiedUpdate,
    route: "/webhook",
    webhookSecretToken: SECRET,
  });
  return { onBotMembership, onVerifiedUpdate, webhook: webhook! };
}

function request(body: unknown, secret = SECRET): Request {
  return new Request("http://localhost/webhook", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    method: "POST",
  });
}

describe("telegram webhook route", () => {
  it("hands a membership update to its own handler, not to the message ingress", async () => {
    const { onBotMembership, onVerifiedUpdate, webhook } = routes();

    const response = await webhook.handle(request({ my_chat_member: MEMBERSHIP, update_id: 1 }), { waitUntil: vi.fn() });

    expect(response.status).toBe(200);
    expect(onBotMembership).toHaveBeenCalledWith(MEMBERSHIP, expect.objectContaining({ waitUntil: expect.any(Function) }));
    expect(onVerifiedUpdate).not.toHaveBeenCalled();
  });

  it("refuses a membership update without the secret", async () => {
    const { onBotMembership, webhook } = routes();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await webhook.handle(request({ my_chat_member: MEMBERSHIP, update_id: 1 }, "wrong"), { waitUntil: vi.fn() });

    expect(response.status).toBe(401);
    expect(onBotMembership).not.toHaveBeenCalled();
  });
});
