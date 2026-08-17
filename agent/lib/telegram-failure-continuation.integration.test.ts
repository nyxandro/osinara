/**
 * Eve Telegram failure continuation integration test.
 *
 * Constructs covered:
 * - Installed Eve `channel.telegram.post`: re-anchors group state after an outbound failure reply.
 * - `handleTelegramSessionFailure`: records Eve's required channel-local continuation address.
 * - Hook ownership conflicts do not mutate or notify the healthy session owner.
 */
import {
  telegramChannel,
  type TelegramChannelState,
  type TelegramEventContext,
} from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { formatTelegramSessionFailure } from "./telegram-interface.js";
import { handleTelegramSessionFailure } from "./telegram-session-failure.js";

interface EveTelegramAdapter {
  createAdapterContext(input: {
    ctx: Record<string, never>;
    session: {
      continuation: {
        rekey(token: string): void;
        token: string;
      };
    };
    state: TelegramChannelState;
  }): TelegramEventContext;
  state: TelegramChannelState;
  "session.failed"(
    data: { code: string; details?: Readonly<Record<string, unknown>> },
    channel: TelegramEventContext,
  ): Promise<void>;
}

describe("Eve Telegram failure continuation", () => {
  it("re-keys a group session when the failure message is posted", async () => {
    const telegramFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { chat: { id: -1001, type: "supergroup" }, message_id: 172 },
        }),
        { status: 200 },
      ),
    );
    const channel = telegramChannel({
      api: { fetch: telegramFetch },
      botUsername: "osinara_bot",
      credentials: { botToken: "test-token" },
      events: {
        async "session.failed"(data, context) {
          await context.telegram.post(formatTelegramSessionFailure(data));
        },
      },
    });
    const adapter = (channel as unknown as { adapter: EveTelegramAdapter }).adapter;
    const state: TelegramChannelState = {
      ...adapter.state,
      chatId: "-1001",
      chatType: "supergroup",
      conversationId: "166",
    };
    const rekey = vi.fn();
    const context = adapter.createAdapterContext({
      ctx: {},
      session: { continuation: { rekey, token: "-1001::166" } },
      state,
    });

    await adapter["session.failed"]({ code: "AGENT_SESSION_FAILED" }, context);

    expect(state.conversationId).toBe("172");
    expect(rekey).toHaveBeenCalledWith("-1001::172");
  });

  it("records Eve's channel-local Telegram continuation token", async () => {
    const recordSessionFailedByContinuationToken = vi.fn();
    const request = vi.fn().mockResolvedValue({
      body: { ok: true, result: { message_id: 172 } },
      ok: true,
      status: 200,
    });
    const channel = {
      continuation: { token: "-1001::166" },
      state: { chatId: "649624756", chatType: "private", messageThreadId: null },
      telegram: {
        request,
      },
    };

    await handleTelegramSessionFailure(
      { code: "AGENT_SESSION_FAILED", message: "failed", sessionId: "wrun_failed" },
      channel as never,
      { recordSessionFailedByContinuationToken },
      { failRunByIdentityForNotification: vi.fn() },
    );

    expect(recordSessionFailedByContinuationToken).toHaveBeenCalledWith(
      "-1001::166",
      "wrun_failed",
    );
    expect(recordSessionFailedByContinuationToken.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[0]!,
    );
    expect(channel.continuation.token).toBe("-1001::166");
  });

  it("records a group session failure without publishing it to the group", async () => {
    const recordSessionFailedByContinuationToken = vi.fn().mockResolvedValue("recorded");
    const request = vi.fn();

    await handleTelegramSessionFailure(
      { code: "AGENT_SESSION_FAILED", message: "failed", sessionId: "wrun_group" },
      {
        continuation: { token: "-1001::166" },
        state: { chatId: "-1001", chatType: "supergroup", messageThreadId: null },
        telegram: { request },
      } as never,
      { recordSessionFailedByContinuationToken },
      { failRunByIdentityForNotification: vi.fn() },
    );

    expect(recordSessionFailedByContinuationToken).toHaveBeenCalledWith(
      "-1001::166",
      "wrun_group",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("does not notify or rotate when the terminal event belongs to a stale Eve root", async () => {
    const recordSessionFailedByContinuationToken = vi.fn().mockResolvedValue("stale");
    const request = vi.fn();

    await handleTelegramSessionFailure(
      { code: "AGENT_SESSION_FAILED", message: "failed", sessionId: "wrun_old" },
      {
        continuation: { token: "-1001::166" },
        state: { chatId: "-1001", messageThreadId: null },
        telegram: { request },
      } as never,
      { recordSessionFailedByContinuationToken },
      { failRunByIdentityForNotification: vi.fn() },
    );

    expect(recordSessionFailedByContinuationToken).toHaveBeenCalledWith(
      "-1001::166",
      "wrun_old",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("ignores a HookConflictError owned by the healthy session", async () => {
    const recordSessionFailedByContinuationToken = vi.fn();
    const request = vi.fn();

    await handleTelegramSessionFailure(
      {
        code: "SESSION_FAILED",
        details: { name: "HookConflictError", token: "telegram:-1001::166" },
        message: "HookConflictError: Hook token is already in use",
        sessionId: "wrun_competing",
      },
      {
        continuation: { token: "-1001::166" },
        state: { chatId: "-1001", messageThreadId: null },
        telegram: { request },
      } as never,
      { recordSessionFailedByContinuationToken },
      { failRunByIdentityForNotification: vi.fn() },
    );

    expect(recordSessionFailedByContinuationToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("closes a scheduled run without notifying a destination whose authorization was revoked", async () => {
    const recordSessionFailedByContinuationToken = vi.fn().mockResolvedValue("recorded");
    const failRunByIdentityForNotification = vi.fn().mockResolvedValue(false);
    const request = vi.fn();
    const runId = "9c0a1516-5900-47bc-83df-ec4762a5583a";

    await handleTelegramSessionFailure(
      { code: "MODEL_SESSION_FAILED", message: "failed", sessionId: "wrun_scheduled" },
      {
        continuation: { token: `-1001::schedule:${runId}` },
        state: { chatId: "-1001", messageThreadId: null },
        telegram: { request },
      } as never,
      { recordSessionFailedByContinuationToken },
      { failRunByIdentityForNotification },
    );

    expect(failRunByIdentityForNotification).toHaveBeenCalledWith(
      runId,
      "wrun_scheduled",
      "MODEL_SESSION_FAILED",
      expect.any(Date),
    );
    expect(recordSessionFailedByContinuationToken).toHaveBeenCalledWith(
      `-1001::schedule:${runId}`,
      "wrun_scheduled",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("fails fast when Eve does not expose a continuation address", async () => {
    const recordSessionFailedByContinuationToken = vi.fn();
    const request = vi.fn();

    await expect(handleTelegramSessionFailure(
      { code: "AGENT_SESSION_FAILED", message: "failed", sessionId: "wrun_failed" },
      {
        state: { chatId: "-1001", messageThreadId: null },
        telegram: { request },
      } as never,
      { recordSessionFailedByContinuationToken },
      { failRunByIdentityForNotification: vi.fn() },
    )).rejects.toMatchObject({ code: "AGENT_SESSION_CONTINUATION_INVALID" });

    expect(recordSessionFailedByContinuationToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
