/**
 * The verified Telegram webhook route.
 *
 * Constructs covered:
 * - A `my_chat_member` update goes to its own handler and never to the message ingress (#465).
 * - An update without the webhook secret reaches neither.
 * - A widget press (`widget_query`) goes to its own handler; the beta server, recognised by its own
 *   secret, delivers only presses: any other update from it is dropped as a copy.
 */
import { describe, expect, it, vi } from "vitest";

import { telegramWebhookRoutes } from "./telegram-channel.js";

const SECRET = "webhook-secret";
const WIDGET_SECRET = "widget-server-secret";
const MEMBERSHIP = {
  chat: { id: -1001, type: "supergroup" },
  date: 1_762_300_000,
  new_chat_member: { status: "kicked", user: { id: 900, is_bot: true } },
};

function routes() {
  const onBotMembership = vi.fn(async () => undefined);
  const onVerifiedUpdate = vi.fn(async () => new Response("ok"));
  const onWidgetQuery = vi.fn(async () => undefined);
  const [webhook] = telegramWebhookRoutes({
    drainRoute: "/drain",
    onBotMembership,
    onDrain: vi.fn(),
    onVerifiedUpdate,
    onWidgetQuery,
    route: "/webhook",
    webhookSecretToken: SECRET,
    widgetSecretToken: WIDGET_SECRET,
  });
  return { onBotMembership, onVerifiedUpdate, onWidgetQuery, webhook: webhook! };
}

const PRESS = { update_id: 69_454_100, widget_query: { data: "a0.0.A", id: "q", message_id: 7 } };
const MESSAGE = { message: { chat: { id: 42, type: "private" }, date: 1, from: { first_name: "A", id: 42, is_bot: false }, message_id: 9, text: "hi" }, update_id: 69_454_101 };

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

  it("hands a widget press to its own handler, from either server", async () => {
    const { onVerifiedUpdate, onWidgetQuery, webhook } = routes();
    expect((await webhook.handle(request(PRESS, WIDGET_SECRET), { waitUntil: vi.fn() })).status).toBe(200);
    expect((await webhook.handle(request(PRESS), { waitUntil: vi.fn() })).status).toBe(200);
    expect(onWidgetQuery).toHaveBeenCalledTimes(2);
    expect(onVerifiedUpdate).not.toHaveBeenCalled();
  });

  it("drops anything but a press from the widget server", async () => {
    const { onVerifiedUpdate, onWidgetQuery, webhook } = routes();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await webhook.handle(request(MESSAGE, WIDGET_SECRET), { waitUntil: vi.fn() })).status).toBe(200);
    expect(onVerifiedUpdate).not.toHaveBeenCalled();
    expect(onWidgetQuery).not.toHaveBeenCalled();
    expect((await webhook.handle(request(MESSAGE), { waitUntil: vi.fn() })).status).toBe(200);
    expect(onVerifiedUpdate).toHaveBeenCalledTimes(1);
  });
});
