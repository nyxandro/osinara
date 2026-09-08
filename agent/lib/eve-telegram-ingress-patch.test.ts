/**
 * Local Eve Telegram ingress patch contract tests.
 *
 * Constructs covered:
 * - `onVerifiedUpdate`: runs only after webhook verification and parsing.
 * - Patched native dispatch: returns the Eve session and accepts application continuation/auth.
 * - `replyHandling: "message"`: suppresses only preliminary Telegram HITL reply synthesis.
 * - Application-authored durable message overrides replace only the model-visible inbound text.
 * - Pure HITL callbacks do not insert channel context between approval and tool execution.
 * - A bot sender reaches `onMessage`, leaving admission to application authorization.
 * - Patch installation remains safe when lifecycle scripts invoke it repeatedly.
 * - Callback-specific routing contracts live in `eve-telegram-ingress-patch-hitl.test.ts`.
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  parseTelegramUpdate,
  telegramChannel,
  type TelegramInboundResult,
} from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { callAdapterEventHandler } from "../../node_modules/eve/dist/src/channel/adapter.js";

interface HttpRoute {
  handler(request: Request, context: Record<string, unknown>): Promise<Response>;
}

const execFileAsync = promisify(execFile);
const patchCommand = ["--experimental-strip-types", "scripts/apply-eve-patches.ts"];
const patchStderr = expect.stringMatching(/^(?:\(node:\d+\) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time\n\(Use .+ to show where the warning was created\)\n)?$/u);

function createChannelSource(session: Record<string, unknown> = { id: "session-test" }) {
  const send = vi.fn().mockResolvedValue(session);
  const respond = vi.fn().mockResolvedValue(session);
  const from = vi.fn(() => ({ respond, send }));
  return { from, respond, send };
}

describe("Eve Telegram verified ingress patch", () => {
  it("can be applied repeatedly without changing its reviewed anchors", async () => {
    await expect(execFileAsync(process.execPath, patchCommand)).resolves.toMatchObject({ stderr: patchStderr });
    const indexTypesPath = "node_modules/eve/dist/src/public/channels/telegram/index.d.ts";
    const before = await readFile(indexTypesPath, "utf8");

    await expect(execFileAsync(process.execPath, patchCommand)).resolves.toMatchObject({ stderr: patchStderr });

    await expect(readFile(indexTypesPath, "utf8")).resolves.toBe(before);
  });

  it("pins the reviewed runtime and public type seam exactly once", async () => {
    const patchSource = await readFile("scripts/apply-eve-patches.ts", "utf8");
    const runtime = await readFile(
      "node_modules/eve/dist/src/public/channels/telegram/telegramChannel.js",
      "utf8",
    );
    const inputRequestsRuntime = await readFile(
      "node_modules/eve/dist/src/harness/input-requests.js",
      "utf8",
    );
    const types = await readFile(
      "node_modules/eve/dist/src/public/channels/telegram/telegramChannel.d.ts",
      "utf8",
    );
    const valid: TelegramInboundResult = {
      auth: null,
      message: "durable group context\n\ncurrent message",
      replyHandling: "message",
    };
    const callbackResult = {
      acknowledgementText: "Решение сохранено",
      auth: null,
      continuationToken: "101::",
    } satisfies import("eve/channels/telegram").TelegramHitlCallbackResult;
    // @ts-expect-error The pinned seam deliberately permits no other handling modes.
    const invalid: TelegramInboundResult = { auth: null, replyHandling: "hitl" };

    expect(patchSource).toContain('const EXPECTED_EVE_VERSION = "0.40.0";');
    expect(runtime.match(/r\.replyHandling!==`message`/g)).toHaveLength(1);
    expect(runtime.match(/i\.acknowledgementText\?\?`Answer received\.`/g)).toHaveLength(1);
    expect(runtime.match(/n\.send\(r\.message\?\?a/g)).toHaveLength(1);
    // Eve natively defers callback context until after the isolated approval step.
    expect(inputRequestsRuntime).toContain("deferMessagesWhileApprovalsPending");
    expect(inputRequestsRuntime).toContain("queueDeferredStepInput");
    expect(types.match(/readonly message\?: string;/g)).toHaveLength(1);
    expect(types.match(/readonly replyHandling\?: "message";/g)).toHaveLength(1);
    expect(valid).toMatchObject({ replyHandling: "message" });
    expect(invalid).toBeDefined();
    expect(callbackResult.acknowledgementText).toBe("Решение сохранено");
  });

  it("never exposes an update to the durable hook before webhook authentication", async () => {
    const onVerifiedUpdate = vi.fn();
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onVerifiedUpdate,
    });
    const route = channel.routes[0] as unknown as HttpRoute;

    const response = await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({ update_id: 1000 }),
      headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
      method: "POST",
    }), {
      from: vi.fn(),
      params: {},
      requestIp: null,
      waitUntil: vi.fn(),
    });

    expect(response.status).toBe(401);
    expect(onVerifiedUpdate).not.toHaveBeenCalled();
  });

  it("delivers a bot sender to the application message handler", async () => {
    const source = createChannelSource({ id: "session-bot" });
    const onMessage = vi.fn<
      (...args: [unknown, import("eve/channels/telegram").TelegramMessage]) => Promise<TelegramInboundResult>
    >().mockResolvedValue({ auth: null });
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onMessage,
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: -1_002_000_000_001, title: "BotBattle", type: "supergroup" },
          date: 1_700_000_000,
          from: { first_name: "Мия", id: 8_123_456_789, is_bot: true, username: "mimimia_ai_bot" },
          message_id: 91,
          text: "@osinara_bot привет",
        },
        update_id: 1101,
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

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[1]).toMatchObject({
      from: { id: "8123456789", isBot: true, username: "mimimia_ai_bot" },
    });
  });

  it("sends an application-authored durable message override", async () => {
    const source = createChannelSource({ id: "session-context" });
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onMessage: async () => ({ auth: null, message: "durable context\n\nПривет" }),
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
          text: "Привет",
        },
        update_id: 1007,
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

    expect(source.send.mock.calls[0]?.[0]).toBe("durable context\n\nПривет");
  });

  it("fails fast when the pinned Telegram runtime artifact does not match", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-eve-patch-mismatch-"));
    const eveTarget = join(root, "node_modules/eve");
    const runtimePath = join(
      eveTarget,
      "dist/src/public/channels/telegram/telegramChannel.js",
    );
    try {
      await cp(resolve("node_modules/eve"), eveTarget, { recursive: true });
      await cp(resolve("node_modules/@workflow/world-postgres"), join(root, "node_modules/@workflow/world-postgres"), { recursive: true });
      await cp(resolve("node_modules/ai"), join(root, "node_modules/ai"), { recursive: true });
      await cp(resolve("scripts/eve-runtime"), join(root, "scripts/eve-runtime"), { recursive: true });
      await cp(resolve("scripts/runtime"), join(root, "scripts/runtime"), { recursive: true });
      const runtime = await readFile(runtimePath, "utf8");
      await writeFile(runtimePath, runtime.replace(
        "r.replyHandling!==`message`",
        "r.replyHandling!==`unexpected_reviewed_artifact`",
      ));

      await expect(execFileAsync(process.execPath, [
        "--experimental-strip-types",
        resolve("scripts/apply-eve-patches.ts"),
      ], { cwd: root })).rejects.toMatchObject({
        stderr: expect.stringContaining("AGENT_EVE_PATCH_MISMATCH"),
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 15_000);

  it("fails fast when the installed Eve version does not match", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-eve-version-mismatch-"));
    const eveTarget = join(root, "node_modules/eve");
    const packagePath = join(eveTarget, "package.json");
    try {
      await cp(resolve("node_modules/eve"), eveTarget, { recursive: true });
      const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
      await writeFile(packagePath, `${JSON.stringify({ ...packageJson, version: "0.31.0" })}\n`);

      await expect(execFileAsync(process.execPath, [
        "--experimental-strip-types",
        resolve("scripts/apply-eve-patches.ts"),
      ], { cwd: root })).rejects.toMatchObject({
        stderr: expect.stringContaining("AGENT_EVE_PATCH_VERSION_UNSUPPORTED"),
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 15_000);

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
    const source = createChannelSource({
      continuationToken: "101::",
      getEventStream: vi.fn(),
      id: "session-1",
    });
    let backgroundTask: Promise<unknown> | undefined;
    let dispatchedSession: unknown;
    const onVerifiedUpdate = vi.fn((context) => {
      context.waitUntil(context.dispatch(context.update).then((session: unknown) => {
        dispatchedSession = session;
      }));
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
      from: source.from,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(response.status).toBe(202);
    expect(onVerifiedUpdate).toHaveBeenCalledTimes(1);
    expect(source.send).toHaveBeenCalledTimes(1);
    expect(dispatchedSession).toMatchObject({ id: "session-1" });
  });

  it("uses the application continuation token returned by the authorized message handler", async () => {
    const source = createChannelSource({ id: "session-rotated" });
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
      from: source.from,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(source.from).toHaveBeenCalledWith("101:::osinara:2");
  });

  it("dispatches a timeline reply as a message when the handler opts out of HITL synthesis", async () => {
    const source = createChannelSource({ id: "session-fresh-reply" });
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onMessage: async () => ({
        auth: null,
        continuationToken: "-100::340:osinara:2",
        replyHandling: "message" as const,
      }),
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: -100, type: "supergroup" },
          date: 1_700_000_000,
          from: { first_name: "Анна", id: 101, is_bot: false },
          message_id: 342,
          reply_to_message: {
            chat: { id: -100, type: "supergroup" },
            date: 1_699_999_999,
            from: { first_name: "Osinara", id: 999, is_bot: true },
            message_id: 340,
            text: "Предыдущий ответ",
          },
          text: "Продолжи",
        },
        update_id: 1005,
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

    expect(source.send.mock.calls[0]?.[0]).toEqual(expect.anything());
    expect(source.respond).not.toHaveBeenCalled();
    expect(source.from).toHaveBeenCalledWith("-100::340:osinara:2");
    expect(source.send.mock.calls[0]?.[1]).toMatchObject({
      state: {
        chatId: "-100",
        conversationId: "340",
      },
    });
  });

  it("preserves native synthetic HITL reply handling when the opt-out is absent", async () => {
    const source = createChannelSource({ id: "session-hitl-reply" });
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onMessage: async () => ({ auth: null }),
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: -100, type: "supergroup" },
          date: 1_700_000_000,
          from: { first_name: "Анна", id: 101, is_bot: false },
          message_id: 343,
          reply_to_message: {
            chat: { id: -100, type: "supergroup" },
            date: 1_699_999_999,
            from: { first_name: "Osinara", id: 999, is_bot: true },
            message_id: 341,
            text: "Подтвердите действие",
          },
          text: "Да",
        },
        update_id: 1006,
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

    expect(source.respond.mock.calls[0]?.[0]).toEqual([{
      requestId: "telegram_reply:341",
      text: "Да",
    }]);
  });

  it("exposes an authenticated private drain route on the same adapter", async () => {
    const source = createChannelSource({ id: "session-drain" });
    const update = parseTelegramUpdate({
      message: {
        chat: { id: 101, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Анна", id: 101, is_bot: false },
        message_id: 79,
        text: "Из очереди",
      },
      update_id: 1008,
    });
    if (update === null) throw new Error("TEST_TELEGRAM_UPDATE_INVALID");
    const onDrain = vi.fn((context) => {
      context.waitUntil(context.dispatch(update));
      return new Response("drained");
    });
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      drainRoute: "/eve/v1/telegram-drain",
      onDrain,
    });
    const route = channel.routes[1] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;
    const response = await route.handler(
      new Request("http://agent:3000/eve/v1/telegram-drain", {
        body: "{}",
        headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
        method: "POST",
      }),
      {
        params: {},
        requestIp: null,
        from: source.from,
        waitUntil(task: Promise<unknown>) {
          backgroundTask = task;
        },
      },
    );
    await backgroundTask;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("drained");
    expect(onDrain).toHaveBeenCalledTimes(1);
    expect(source.send).toHaveBeenCalledTimes(1);
  });
});
