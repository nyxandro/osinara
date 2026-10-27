/**
 * Reply buttons on a turn's final answer.
 *
 * Constructs covered:
 * - Buttons the model wrote leave the answer's text, and the delivery is told the answer carries
 *   them, so it ends in a rich message.
 * - They ride on the last message of a split answer only, written into it just before it is sent;
 *   the set is activated with the message numbers Telegram confirmed.
 * - An answer without buttons is sent as written.
 * - Buttons in a note before a tool call are reported and never sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  afterDelivery: vi.fn(),
  deliver: vi.fn(),
  postPlain: vi.fn(),
  postRich: vi.fn(),
  progress: vi.fn(),
  report: vi.fn(),
  sendLast: vi.fn(),
  turnButtons: vi.fn(),
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
vi.mock("./telegram-final-delivery.js", () => ({ deliverTelegramFinalOutput: dependencies.deliver }));
vi.mock("./telegram-plain-messages.js", () => ({ postTelegramPlainMessageChunk: dependencies.postPlain }));
vi.mock("./telegram-rich-messages.js", () => ({ postTelegramRichMessageChunk: dependencies.postRich }));
vi.mock("./telegram-progress-notice.js", () => ({ deliverTelegramProgressNotice: dependencies.progress }));
vi.mock("./conversation-timeline-repository.js", () => ({
  conversationTimelineRepository: { recordAgentResponse: vi.fn() },
}));
vi.mock("./reply-buttons/reply-button-delivery.js", () => ({
  reportUndeliveredReplyButtons: dependencies.report,
  turnReplyButtons: dependencies.turnButtons,
}));

const { telegramTurnEvents } = await import("../channels/telegram.js");

const ROW = "<tg-button-row><tg-button style=\"success\">✅ Да</tg-button></tg-button-row>";
const ROWS = [[{ color: "green", text: "✅ Да" }]];
const ATTRIBUTES = { telegramChatId: "101", telegramChatType: "private", telegramConversationId: "conversation-1" };
const context = {
  session: {
    auth: { current: { attributes: ATTRIBUTES, authenticator: "telegram" }, initiator: null },
    id: "agent-session-1",
    turn: { id: "turn-1", sequence: 1 },
  },
};
const channel = { state: { chatId: "101", chatType: "private" }, telegram: { chatId: "101", startTyping: vi.fn() } };

async function complete(message: string, finishReason = "stop") {
  const handler = (telegramTurnEvents as Record<string, any>)["message.completed"];
  await handler({ finishReason, message }, channel, context);
}

describe("reply buttons on the final answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let messageId = 600;
    const sent = async () => ({ chatType: "private", messageId: String(++messageId) });
    dependencies.postPlain.mockImplementation(sent);
    dependencies.postRich.mockImplementation(sent);
    // Two chunks, as a long answer split by Telegram's size limit would be.
    dependencies.deliver.mockImplementation(async (input: {
      sendChunk: (chunk: unknown, ordinal: number, last: boolean) => Promise<{ messageId: string }>;
    }) => [
      await input.sendChunk({ format: "plain", pacing: "immediate", text: "Первая часть" }, 0, false),
      await input.sendChunk({ format: "rich", pacing: "immediate", text: "Оформляем?" }, 1, true),
    ]);
  });

  it("writes the buttons into the last message only and activates them under it", async () => {
    dependencies.sendLast.mockImplementation(async (_chunk: unknown, post: (text: string) => Promise<unknown>) =>
      await post(`Оформляем?\n\n${ROW}`));
    dependencies.turnButtons.mockReturnValue({ afterDelivery: dependencies.afterDelivery, sendLast: dependencies.sendLast });

    await complete(`Первая часть\n\nОформляем?\n\n${ROW}`);

    expect(dependencies.turnButtons).toHaveBeenCalledWith({
      agentSessionId: "agent-session-1",
      agentTurnId: "turn-1",
      attributes: ATTRIBUTES,
      found: { error: null, rows: ROWS },
      telegramChatId: "101",
    });
    expect(dependencies.deliver).toHaveBeenCalledWith(expect.objectContaining({
      markdown: "Первая часть\n\nОформляем?",
      replyButtons: true,
    }));
    expect(dependencies.sendLast).toHaveBeenCalledTimes(1);
    expect(dependencies.sendLast).toHaveBeenCalledWith(expect.objectContaining({ format: "rich", text: "Оформляем?" }), expect.any(Function));
    expect(dependencies.postPlain.mock.calls[0]![0]).toBe("Первая часть");
    expect(dependencies.postRich.mock.calls[0]![0]).toBe(`Оформляем?\n\n${ROW}`);
    expect(dependencies.afterDelivery).toHaveBeenCalledWith([
      { chatType: "private", messageId: "601" },
      { chatType: "private", messageId: "602" },
    ]);
  });

  it("sends an answer without buttons as written", async () => {
    dependencies.turnButtons.mockReturnValue(null);

    await complete("Первая часть\n\nОформляем?");

    expect(dependencies.turnButtons).toHaveBeenCalledWith(expect.objectContaining({ found: undefined }));
    expect(dependencies.deliver).toHaveBeenCalledWith(expect.objectContaining({ replyButtons: false }));
    expect(dependencies.postRich.mock.calls[0]![0]).toBe("Оформляем?");
  });

  it("reports buttons in a note before a tool call and sends the note without them", async () => {
    await complete(`Секунду, ищу.\n\n${ROW}`, "tool-calls");

    expect(dependencies.report).toHaveBeenCalledWith({ error: null, rows: ROWS }, { agentTurnId: "turn-1" });
    expect(dependencies.progress).toHaveBeenCalledWith(expect.objectContaining({ message: "Секунду, ищу." }));
  });
});
