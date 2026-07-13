/**
 * Local Eve Telegram ingress patch contract tests.
 *
 * Constructs covered:
 * - `onVerifiedUpdate`: runs only after webhook verification and parsing.
 * - Patched native dispatch: returns the Eve session and accepts application continuation/auth.
 * - Patch installation remains safe when lifecycle scripts invoke it repeatedly.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { telegramChannel } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { callAdapterEventHandler } from "../../node_modules/eve/dist/src/channel/adapter.js";

interface HttpRoute {
  handler(request: Request, context: Record<string, unknown>): Promise<Response>;
}

const execFileAsync = promisify(execFile);

describe("Eve Telegram verified ingress patch", () => {
  it("can be applied repeatedly without changing its reviewed anchors", async () => {
    const command = [
      "--experimental-strip-types",
      "scripts/apply-eve-patches.ts",
    ];
    await expect(execFileAsync(process.execPath, command)).resolves.toMatchObject({ stderr: "" });
    const indexTypesPath = "node_modules/eve/dist/src/public/channels/telegram/index.d.ts";
    const before = await readFile(indexTypesPath, "utf8");

    await expect(execFileAsync(process.execPath, command)).resolves.toMatchObject({ stderr: "" });

    await expect(readFile(indexTypesPath, "utf8")).resolves.toBe(before);
  });

  it("propagates input.requested handler failures instead of parking an unbound approval", async () => {
    const error = new Error("AGENT_APPROVAL_STORAGE_FAILED");
    const adapter = {
      kind: "telegram",
      "input.requested": vi.fn().mockRejectedValue(error),
    };

    await expect(callAdapterEventHandler(
      adapter as never,
      { data: { requests: [] }, type: "input.requested" } as never,
      {} as never,
    )).rejects.toBe(error);
  });

  it("acknowledges through the hook and dispatches with the native channel adapter", async () => {
    const send = vi.fn().mockResolvedValue({
      continuationToken: "101::",
      getEventStream: vi.fn(),
      id: "session-1",
    });
    let backgroundTask: Promise<unknown> | undefined;
    const onVerifiedUpdate = vi.fn((context) => {
      context.waitUntil(context.dispatch(context.update));
      return new Response("queued", { status: 202 });
    });
    const channel = telegramChannel({
      botUsername: "osinara_bot",
      credentials: { webhookSecretToken: "webhook-secret" },
      onMessage: async () => ({ auth: null }),
      onVerifiedUpdate,
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    const request = new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: 101, type: "private" },
          date: 1_700_000_000,
          from: { first_name: "Анна", id: 101, is_bot: false },
          message_id: 77,
          text: "Привет",
        },
        update_id: 1001,
      }),
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      method: "POST",
    });

    const response = await route.handler(request, {
      params: {},
      requestIp: null,
      send,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(response.status).toBe(202);
    expect(onVerifiedUpdate).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses the application continuation token returned by the authorized message handler", async () => {
    const send = vi.fn().mockResolvedValue({ id: "session-rotated" });
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onMessage: async () => ({ auth: null, continuationToken: "101:::osinara:2" }),
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: 101, type: "private" },
          date: 1_700_000_000,
          from: { first_name: "Анна", id: 101, is_bot: false },
          message_id: 78,
          text: "Продолжим",
        },
        update_id: 1002,
      }),
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      method: "POST",
    }), {
      params: {},
      requestIp: null,
      send,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(send.mock.calls[0]?.[1]).toMatchObject({
      continuationToken: "101:::osinara:2",
    });
  });

  it("resolves a rotated continuation token for HITL callbacks before delivery", async () => {
    const send = vi.fn().mockResolvedValue({ id: "session-callback" });
    const auth = {
      attributes: { applicationSessionId: "app-session-1", role: "owner" },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user" as const,
    };
    const onHitlCallbackQuery = vi.fn().mockResolvedValue({
      auth,
      continuationToken: "-100:55:77:osinara:3",
    });
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
      send,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(onHitlCallbackQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "callback-1" }),
      "-100:55:77",
    );
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      auth,
      continuationToken: "-100:55:77:osinara:3",
    });
  });

  it("does not resume Eve when the application rejects a HITL callback", async () => {
    const send = vi.fn();
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
      send,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(onHitlCallbackQuery).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("exposes an authenticated private drain route on the same adapter", async () => {
    const onDrain = vi.fn(() => new Response("drained"));
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      drainRoute: "/eve/v1/telegram-drain",
      onDrain,
    });
    const route = channel.routes[1] as unknown as HttpRoute;
    const response = await route.handler(
      new Request("http://agent:3000/eve/v1/telegram-drain", {
        body: "{}",
        headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
        method: "POST",
      }),
      {
        params: {},
        requestIp: null,
        send: vi.fn(),
        waitUntil: vi.fn(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("drained");
    expect(onDrain).toHaveBeenCalledTimes(1);
  });
});
