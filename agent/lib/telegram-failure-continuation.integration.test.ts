/**
 * Eve Telegram failure continuation integration test.
 *
 * Constructs covered:
 * - Installed Eve `channel.telegram.post`: re-anchors group state after an outbound failure reply.
 * - Installed Eve session bridge: updates the durable continuation token with the new anchor.
 */
import {
  telegramChannel,
  type TelegramChannelState,
  type TelegramEventContext,
} from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { formatTelegramSessionFailure } from "./telegram-interface.js";

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
});
