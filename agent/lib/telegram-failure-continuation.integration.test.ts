/**
 * Eve Telegram failure continuation integration test.
 *
 * Constructs covered:
 * - Installed Eve `channel.telegram.post`: re-anchors group state after an outbound failure reply.
 * - `handleTelegramSessionFailure`: records the pre-post continuation route before the anchor changes.
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
      continuationToken: string;
      setContinuationToken(token: string): void;
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
    const setContinuationToken = vi.fn();
    const context = adapter.createAdapterContext({
      ctx: {},
      session: { continuationToken: "-1001::166", setContinuationToken },
      state,
    });

    await adapter["session.failed"]({ code: "AGENT_SESSION_FAILED" }, context);

    expect(state.conversationId).toBe("172");
    expect(setContinuationToken).toHaveBeenCalledWith("-1001::172");
  });

  it("records the route that existed before the failure reply changed the group anchor", async () => {
    const recordSessionFailedByContinuationToken = vi.fn();
    const channel = {
      continuationToken: "-1001::166",
      telegram: {
        post: vi.fn().mockImplementation(async () => {
          channel.continuationToken = "-1001::172";
          return { id: "172", raw: null };
        }),
      },
    };

    await handleTelegramSessionFailure(
      { code: "AGENT_SESSION_FAILED", message: "failed", sessionId: "wrun_failed" },
      channel as never,
      { recordSessionFailedByContinuationToken },
    );

    expect(recordSessionFailedByContinuationToken).toHaveBeenCalledWith(
      "-1001::166",
      "wrun_failed",
    );
    expect(recordSessionFailedByContinuationToken.mock.invocationCallOrder[0]).toBeLessThan(
      channel.telegram.post.mock.invocationCallOrder[0]!,
    );
  });

  it("does not notify or rotate when the terminal event belongs to a stale Eve root", async () => {
    const recordSessionFailedByContinuationToken = vi.fn().mockResolvedValue("stale");
    const post = vi.fn();

    await handleTelegramSessionFailure(
      { code: "AGENT_SESSION_FAILED", message: "failed", sessionId: "wrun_old" },
      { continuationToken: "-1001::166", telegram: { post } } as never,
      { recordSessionFailedByContinuationToken },
    );

    expect(recordSessionFailedByContinuationToken).toHaveBeenCalledWith(
      "-1001::166",
      "wrun_old",
    );
    expect(post).not.toHaveBeenCalled();
  });
});
