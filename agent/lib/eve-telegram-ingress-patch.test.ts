/**
 * Local Eve Telegram ingress patch contract tests.
 *
 * Constructs covered:
 * - `onVerifiedUpdate`: runs only after webhook verification and parsing.
 * - Patched native dispatch: returns the Eve session and accepts application continuation tokens.
 * - Patched attachment fetch: ignores Telegram's generic binary MIME for verified photos.
 * - Patch installation remains safe when lifecycle scripts invoke it repeatedly.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { telegramChannel } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import {
  createTelegramFetchFile,
  createTelegramFileUrl,
} from "../../node_modules/eve/dist/src/public/channels/telegram/attachments.js";

interface HttpRoute {
  handler(request: Request, context: Record<string, unknown>): Promise<Response>;
}

const execFileAsync = promisify(execFile);

describe("Eve Telegram verified ingress patch", () => {
  it("can be applied repeatedly without changing its reviewed anchors", async () => {
    await expect(execFileAsync(process.execPath, [
      "--experimental-strip-types",
      "scripts/apply-eve-patches.ts",
    ])).resolves.toMatchObject({ stderr: "" });
  });

  it("preserves the declared photo MIME when Telegram downloads as generic binary", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { file_path: "photos/file_1.jpg" },
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
        headers: { "content-type": "application/octet-stream" },
      }));
    const fetchFile = createTelegramFetchFile({
      api: { fetch },
      credentials: { botToken: "test-token" },
      policy: { allowedMediaTypes: ["image/*"], maxBytes: 1_024 },
    });
    const url = createTelegramFileUrl({
      fileId: "photo-file-id",
      filename: "photo.jpg",
      mediaType: "image/jpeg",
    });

    await expect(fetchFile(url.toString())).resolves.toMatchObject({
      filename: "photo.jpg",
      mediaType: "image/jpeg",
    });
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
    const resolveContinuationToken = vi.fn().mockResolvedValue("-100:55:77:osinara:3");
    const channel = telegramChannel({
      api: {
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { "content-type": "application/json" },
        })),
      },
      credentials: { botToken: "test-token", webhookSecretToken: "webhook-secret" },
      resolveContinuationToken,
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

    expect(resolveContinuationToken).toHaveBeenCalledWith("-100:55:77");
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      continuationToken: "-100:55:77:osinara:3",
    });
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
