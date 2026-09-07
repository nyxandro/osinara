/** The verified dispatcher fences late preparation and exposes only the authenticated target. */
import { telegramChannel } from "eve/channels/telegram";
import { expect, it, vi } from "vitest";

const raw = { update_id: 900, message: { message_id: 7, date: 1700000000,
  chat: { id: 101, type: "private" }, from: { id: 101, first_name: "User", is_bot: false }, text: "hi" } };
const auth = { authenticator: "telegram", principalType: "user", principalId: "user",
  attributes: { osinaraTelegramDeadlineAt: "spoofed" } };

async function dispatch(onMessage: () => Promise<unknown>, control: unknown) {
  const session = { id: "fixed-session", cancel: vi.fn() };
  const send = vi.fn().mockResolvedValue(session);
  const resolveSession = vi.fn().mockResolvedValue(session);
  const from = vi.fn(() => ({ send, respond: send }));
  const channel = telegramChannel({ credentials: { webhookSecretToken: "secret" },
    onMessage: onMessage as never,
    onVerifiedUpdate: async (ctx) => {
      await (ctx.dispatch as (...args: unknown[]) => Promise<unknown>)(ctx.update, control);
      return new Response("ok");
    },
  });
  const route = channel.routes[0] as unknown as { handler: (req: Request, ctx: unknown) => Promise<Response> };
  const result = route.handler(new Request("https://test.invalid/eve/v1/telegram", { method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify(raw) }),
  { from, resolveSession, waitUntil: vi.fn(), params: {}, requestIp: null });
  return { result, send, resolveSession, session };
}

it("does not send after an aborted slow onMessage returns", async () => {
  let release!: (value: unknown) => void;
  const waiting = new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  const state = await dispatch(() => waiting, { signal: controller.signal,
    deadlineAt: new Date(Date.now() + 1000).toISOString(), dispatchId: "dispatch-1", onDispatch: vi.fn() });
  controller.abort(new Error("TEST_DEADLINE"));
  release({ auth, continuationToken: "authorized-target" });
  await expect(state.result).rejects.toThrow("TEST_DEADLINE");
  expect(state.send).not.toHaveBeenCalled();
});

it("stamps the application deadline and resolves only the selected continuation", async () => {
  const onDispatch = vi.fn();
  const deadlineAt = new Date(Date.now() + 1000).toISOString();
  const state = await dispatch(async () => ({ auth, continuationToken: "authorized-target" }),
    { signal: new AbortController().signal, deadlineAt, dispatchId: "dispatch-1", onDispatch });
  await state.result;
  expect(state.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ auth:
    expect.objectContaining({ attributes: { osinaraTelegramDeadlineAt: deadlineAt, osinaraTelegramIngressId: "dispatch-1" } }) }));
  expect(onDispatch).toHaveBeenCalledTimes(1);
  await expect(onDispatch.mock.calls[0]![0].resolveSession()).resolves.toBe(state.session);
  expect(state.resolveSession).toHaveBeenCalledWith("authorized-target");
});

it("sends one cancellable timeout notice to the verified forum topic and message", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    controller.abort(new Error("TEST_NOTICE_TIMEOUT"));
    init?.signal?.throwIfAborted();
    return Response.json({ ok: true, result: { message_id: 999 } });
  });
  const channel = telegramChannel({ api: { fetch: fetch as typeof globalThis.fetch },
    credentials: { botToken: "test-token", webhookSecretToken: "secret" },
    onVerifiedUpdate: async (ctx) => {
      await (ctx.notifyTimeout as (...args: unknown[]) => Promise<unknown>)(ctx.update, "AGENT_TELEGRAM_PROCESSING_TIMEOUT: Запрос остановлен", controller.signal);
      return new Response("ok");
    },
  });
  const route = channel.routes[0] as unknown as { handler: (req: Request, ctx: unknown) => Promise<Response> };
  await expect(route.handler(new Request("https://test.invalid/eve/v1/telegram", { method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ ...raw,
      message: { ...raw.message, chat: { id: -1001, type: "supergroup" }, is_topic_message: true, message_thread_id: 42 },
    }) }), { from: vi.fn(), resolveSession: vi.fn(), waitUntil: vi.fn() })).rejects.toThrow("TEST_NOTICE_TIMEOUT");
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = fetch.mock.calls[0]![1]!;
  expect(request.signal?.aborted).toBe(true);
  expect(JSON.parse(String(request.body))).toMatchObject({ chat_id: "-1001", message_thread_id: 42, reply_parameters: { message_id: 7 } });
});
