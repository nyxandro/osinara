/**
 * Group final-delivery reply binding tests.
 *
 * Constructs covered:
 * - `message.completed` replies to the verified triggering member message by default.
 * - An answer the model marked as standalone reaches Telegram without a reply and without the
 *   directive; the delivery identity records that choice, which the outbox hashes on retry.
 * - A standalone answer still fails on a reply context that does not belong to this chat.
 * - Only the first message of a split answer would carry the reply, so a standalone split sends none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  channelConfig: null as Record<string, any> | null,
  deliverFinalOutput: vi.fn(),
  recordAgentResponse: vi.fn(),
}));

vi.mock("eve/channels/telegram", () => ({
  telegramChannel: (config: Record<string, any>) => {
    dependencies.channelConfig = config;
    return config;
  },
}));
vi.mock("./agent-schedules/scheduled-session.js", () => ({
  isScheduledSession: vi.fn(() => false),
  scheduledDeliveryMetadata: vi.fn(() => null),
}));
vi.mock("./sessions/session-context.js", () => ({
  applicationSessionId: vi.fn(() => "application-session-1"),
  registerTelegramDeliveredMessageRoutes: vi.fn(),
}));
vi.mock("./sessions/session-repository.js", () => ({
  sessionRepository: { isCurrentEveSession: vi.fn(async () => true) },
}));
vi.mock("./memory-usage-report.js", () => ({
  recordMemoryUsageDeclaration: vi.fn(),
}));
vi.mock("./telegram-final-delivery.js", () => ({
  deliverTelegramFinalOutput: dependencies.deliverFinalOutput,
}));
vi.mock("./telegram-group-journal-repository.js", () => ({
  telegramGroupJournalRepository: { recordAgentResponse: dependencies.recordAgentResponse },
}));
vi.mock("./conversation-timeline-repository.js", () => ({
  conversationTimelineRepository: { recordAgentResponse: vi.fn() },
}));

await import("../channels/telegram.js");

const context = {
  session: {
    auth: {
      current: {
        attributes: {
          groupId: "group-1",
          telegramChatId: "-100111",
          telegramChatType: "supergroup",
          telegramMessageId: "42",
          telegramReplyToMessageId: "42",
          telegramTimelineEntryId: "entry-1",
        },
        authenticator: "telegram",
      },
      initiator: null,
    },
    id: "eve-session-1",
    turn: { id: "turn-1", sequence: 1 },
  },
};

const channel = {
  state: { chatId: "-100111", chatType: "supergroup" },
  telegram: { chatId: "-100111" },
};

async function complete(message: string) {
  const handler = dependencies.channelConfig?.events?.["message.completed"];
  await handler({ finishReason: "stop", message }, channel, context);
  return dependencies.deliverFinalOutput.mock.calls[0]?.[0];
}

describe("group final-delivery reply binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.deliverFinalOutput.mockResolvedValue([{ messageId: "501" }]);
  });

  it("replies to the triggering member message by default", async () => {
    const delivery = await complete("Код домофона 4271.");

    expect(delivery.deliveryIdentity.replyParameters).toEqual({
      allow_sending_without_reply: true,
      message_id: 42,
    });
    expect(delivery.markdown).toBe("Код домофона 4271.");
  });

  it("sends an answer marked as standalone without a reply and without the directive", async () => {
    const delivery = await complete("[[no-reply]]\nСоседи, домофон снова не открывает дверь.");

    expect(delivery.deliveryIdentity.replyParameters).toBeNull();
    expect(delivery.markdown).toBe("Соседи, домофон снова не открывает дверь.");
    expect(dependencies.recordAgentResponse).toHaveBeenCalledWith(expect.objectContaining({
      contentText: "Соседи, домофон снова не открывает дверь.",
    }));
  });

  it("keeps the reply-context integrity check for a standalone answer", async () => {
    const handler = dependencies.channelConfig?.events?.["message.completed"];
    const foreignChannel = { ...channel, state: { chatId: "-100999", chatType: "supergroup" } };

    await expect(handler(
      { finishReason: "stop", message: "[[no-reply]]\nОбъявление" },
      foreignChannel,
      context,
    )).rejects.toMatchObject({ code: "AGENT_TELEGRAM_REPLY_CONTEXT_INVALID" });
    expect(dependencies.deliverFinalOutput).not.toHaveBeenCalled();
  });

  it("sends none of the parts of a standalone split answer as a reply", async () => {
    const delivery = await complete("[[no-reply]]\nОбъявление\n[[split]]\nи ещё");

    expect(delivery.deliveryIdentity.replyParameters).toBeNull();
    expect(delivery.markdown).toBe("Объявление\n[[split]]\nи ещё");
  });
});
