/**
 * Reply buttons on a turn's final answer.
 *
 * Constructs covered:
 * - Buttons the turn staged ride on the last message of a split answer only.
 * - The exact text of that message is recorded before it is sent; the set is activated with the
 *   message number Telegram confirmed.
 * - An answer without staged buttons sends no keyboard.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  afterDelivery: vi.fn(),
  prepareLastChunk: vi.fn(),
  postPlain: vi.fn(),
  staged: vi.fn(),
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
  sessionRepository: { isCurrentAgentSession: vi.fn(async () => true) },
}));
vi.mock("./memory-usage-report.js", () => ({ recordMemoryUsageDeclaration: vi.fn() }));
vi.mock("./telegram-final-delivery.js", () => ({
  // Two chunks, as a long answer split by Telegram's size limit would be.
  deliverTelegramFinalOutput: vi.fn(async (input: { sendChunk: (chunk: unknown, ordinal: number, last: boolean) => Promise<{ messageId: string }> }) => [
    await input.sendChunk({ format: "plain", pacing: "immediate", text: "Первая часть" }, 0, false),
    await input.sendChunk({ format: "plain", pacing: "immediate", text: "Оформляем?" }, 1, true),
  ]),
}));
vi.mock("./telegram-plain-messages.js", () => ({ postTelegramPlainMessageChunk: dependencies.postPlain }));
vi.mock("./conversation-timeline-repository.js", () => ({
  conversationTimelineRepository: { recordAgentResponse: vi.fn() },
}));
vi.mock("./reply-buttons/reply-button-delivery.js", () => ({ stagedReplyButtons: dependencies.staged }));

const { telegramTurnEvents } = await import("../channels/telegram.js");

const KEYBOARD = { inline_keyboard: [[{ callback_data: "rb:AbCdEfGhIjKlMnOpQrStUv:0", text: "✅ Да" }]] };
const context = {
  session: {
    auth: {
      current: {
        attributes: { telegramChatId: "101", telegramChatType: "private", telegramConversationId: "conversation-1" },
        authenticator: "telegram",
      },
      initiator: null,
    },
    id: "agent-session-1",
    turn: { id: "turn-1", sequence: 1 },
  },
};
const channel = { state: { chatId: "101", chatType: "private" }, telegram: { chatId: "101", startTyping: vi.fn() } };

async function complete() {
  const handler = (telegramTurnEvents as Record<string, any>)["message.completed"];
  await handler({ finishReason: "stop", message: "Первая часть\n\nОформляем?" }, channel, context);
}

describe("reply buttons on the final answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let messageId = 600;
    dependencies.postPlain.mockImplementation(async () => ({ chatType: "private", messageId: String(++messageId) }));
  });

  it("puts the keyboard on the last message only and activates it under that message", async () => {
    dependencies.prepareLastChunk.mockResolvedValue(KEYBOARD);
    dependencies.staged.mockResolvedValue({
      afterDelivery: dependencies.afterDelivery,
      prepareLastChunk: dependencies.prepareLastChunk,
    });

    await complete();

    expect(dependencies.staged).toHaveBeenCalledWith({ agentTurnId: "turn-1", telegramChatId: "101" });
    expect(dependencies.postPlain.mock.calls.map((call) => call[3])).toEqual([undefined, KEYBOARD]);
    expect(dependencies.prepareLastChunk).toHaveBeenCalledTimes(1);
    expect(dependencies.prepareLastChunk).toHaveBeenCalledWith(expect.objectContaining({ format: "plain", text: "Оформляем?" }));
    expect(dependencies.prepareLastChunk.mock.invocationCallOrder[0]).toBeLessThan(dependencies.postPlain.mock.invocationCallOrder[1]!);
    expect(dependencies.afterDelivery).toHaveBeenCalledWith([
      { chatType: "private", messageId: "601" },
      { chatType: "private", messageId: "602" },
    ]);
  });

  it("sends no keyboard when the turn staged no buttons", async () => {
    dependencies.staged.mockResolvedValue(null);

    await complete();

    expect(dependencies.postPlain.mock.calls.map((call) => call[3])).toEqual([undefined, undefined]);
  });
});
