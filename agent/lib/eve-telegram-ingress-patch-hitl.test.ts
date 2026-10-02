/**
 * Local Eve Telegram ingress patch HITL callback contract tests.
 *
 * Constructs covered:
 * - Rotated application continuation tokens are used for callback delivery.
 * - Explicit Telegram forum topics survive parsing while reply-only pseudo topics are ignored.
 * - Application-rejected callbacks never resume the Eve session.
 */
import { telegramChannel } from "eve/channels/telegram";
import { parseTelegramUpdate } from "../runtime/telegram/inbound.js";
import { describe, expect, it, vi } from "vitest";

interface HttpRoute {
  handler(request: Request, context: Record<string, unknown>): Promise<Response>;
}

function createChannelSource(session: Record<string, unknown> = { id: "session-callback" }) {
  const send = vi.fn().mockResolvedValue(session);
  const respond = vi.fn().mockResolvedValue(session);
  const from = vi.fn(() => ({ respond, send }));
  return { from, respond, send };
}

describe("Eve Telegram verified ingress patch HITL callbacks", () => {
  it("resolves a rotated continuation token for HITL callbacks before delivery", async () => {
    const source = createChannelSource();
    const apiFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), {
      headers: { "content-type": "application/json" },
    }));
    const auth = {
      attributes: { applicationSessionId: "app-session-1", role: "owner" },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user" as const,
    };
    const onHitlCallbackQuery = vi.fn().mockResolvedValue({
      acknowledgementText: "Решение сохранено",
      auth,
      continuationToken: "-100:55:77:osinara:3",
    });
    const channel = telegramChannel({
      api: {
        fetch: apiFetch,
      },
      credentials: { botToken: "test-token", webhookSecretToken: "webhook-secret" },
      onHitlCallbackQuery,
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        callback_query: {
          data: "eve:0",
          from: { first_name: "Анна", id: 101, is_bot: false },
          id: "callback-1",
          message: {
            chat: { id: -100, type: "supergroup" },
            date: 1_700_000_000,
            message_id: 77,
            message_thread_id: 55,
            text: "Подтвердите действие",
          },
        },
        update_id: 1003,
      }),
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      method: "POST",
    }), {
      params: {},
      requestIp: null,
      from: source.from,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(onHitlCallbackQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "callback-1" }),
      "-100::77",
    );
    expect(source.from).toHaveBeenCalledWith("-100:55:77:osinara:3");
    expect(source.respond.mock.calls[0]?.[1]).toMatchObject({
      auth,
    });
    expect(JSON.parse(String(apiFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      text: "Решение сохранено",
    });
  });

  it("preserves an explicit forum topic ID on callback messages", () => {
    const update = parseTelegramUpdate({
      callback_query: {
        data: "eve:0",
        from: { first_name: "Анна", id: 101, is_bot: false },
        id: "callback-forum",
        message: {
          chat: { id: -100, type: "supergroup" },
          is_topic_message: true,
          message_id: 77,
          message_thread_id: 55,
        },
      },
      update_id: 1007,
    });

    expect(update).toMatchObject({
      callbackQuery: { message: { messageThreadId: 55 } },
      kind: "callback_query",
    });
  });

  it("ignores a reply-only pseudo topic ID when Telegram omits the topic marker", () => {
    const update = parseTelegramUpdate({
      callback_query: {
        data: "eve:0",
        from: { first_name: "Анна", id: 101, is_bot: false },
        id: "callback-reply",
        message: {
          chat: { id: -100, type: "supergroup" },
          message_id: 78,
          message_thread_id: 55,
        },
      },
      update_id: 1008,
    });

    expect(update).toMatchObject({
      callbackQuery: { message: { messageId: "78" } },
      kind: "callback_query",
    });
    if (update?.kind !== "callback_query") throw new Error("TEST_CALLBACK_UPDATE_INVALID");
    expect(update.callbackQuery.message?.messageThreadId).toBeUndefined();
  });

  it("does not resume Eve when the application rejects a HITL callback", async () => {
    const source = createChannelSource();
    const onHitlCallbackQuery = vi.fn().mockResolvedValue(null);
    const channel = telegramChannel({
      api: {
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { "content-type": "application/json" },
        })),
      },
      credentials: { botToken: "test-token", webhookSecretToken: "webhook-secret" },
      onHitlCallbackQuery,
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        callback_query: {
          data: "eve:0",
          from: { first_name: "Анна", id: 202, is_bot: false },
          id: "callback-foreign",
          message: {
            chat: { id: -100, type: "supergroup" },
            date: 1_700_000_000,
            message_id: 77,
            text: "Подтвердите действие",
          },
        },
        update_id: 1004,
      }),
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      method: "POST",
    }), {
      params: {},
      requestIp: null,
      from: source.from,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(onHitlCallbackQuery).toHaveBeenCalledTimes(1);
    expect(source.respond).not.toHaveBeenCalled();
  });
});
