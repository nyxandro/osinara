/**
 * Which Telegram turns show "typing" and the answer as it is written.
 *
 * Constructs covered:
 * - A live turn of a private chat gets a presenter; a group, a scheduled run and a wake-up do not:
 *   nobody waits there, or Telegram shows no draft.
 * - The presenter's calls go to the turn's own chat and topic: the draft with the turn's id, the
 *   status as "typing"; a status Telegram refuses reaches the presenter as a failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sends = vi.hoisted(() => ({ sendTelegramChatAction: vi.fn(), sendTelegramRichMessageDraft: vi.fn() }));
vi.mock("../../runtime/telegram/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../runtime/telegram/api.js")>(),
  sendTelegramChatAction: sends.sendTelegramChatAction,
}));
vi.mock("../telegram-rich-messages.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../telegram-rich-messages.js")>(),
  sendTelegramRichMessageDraft: sends.sendTelegramRichMessageDraft,
}));

const { answerDraftTransport, showsAnswerDraft } = await import("./answer-draft-turns.js");

function context(attributes: Record<string, string> = {}) {
  return {
    session: {
      auth: { current: { attributes, authenticator: "telegram", principalId: "user-1", principalType: "user" }, initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as never;
}

function channel(chatType: string, messageThreadId?: number) {
  return { state: {}, telegram: { chatId: "101", chatType, messageThreadId } } as never;
}

beforeEach(() => vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("showsAnswerDraft", () => {
  it("shows a live turn of a private chat and nothing else", () => {
    expect(showsAnswerDraft(channel("private"), context())).toBe(true);
    expect(showsAnswerDraft(channel("supergroup"), context())).toBe(false);
    expect(showsAnswerDraft(channel("private"), context({ scheduledRunId: "00000000-0000-4000-8000-000000000001" }))).toBe(false);
    expect(showsAnswerDraft(channel("private"), context({ conversationScheduleRunId: "00000000-0000-4000-8000-000000000002" }))).toBe(false);
  });
});

describe("answerDraftTransport", () => {
  it("sends the draft with the turn's id and the status as typing, to the turn's chat and topic", async () => {
    sends.sendTelegramRichMessageDraft.mockResolvedValue({ ok: true });
    sends.sendTelegramChatAction.mockResolvedValue({ ok: true, status: 200 });
    const transport = answerDraftTransport(channel("private", 9), context());

    await expect(transport.draft("Пишу")).resolves.toEqual({ ok: true });
    await transport.typing();

    expect(sends.sendTelegramRichMessageDraft).toHaveBeenCalledWith({ chatId: "101", chatType: "private", messageThreadId: 9 }, "turn-1", "Пишу");
    expect(sends.sendTelegramChatAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "typing", chatId: "101", credentials: { botToken: "telegram-bot-secret" }, messageThreadId: 9,
    }));
  });

  it("hands a refused status to the presenter as a failure", async () => {
    sends.sendTelegramChatAction.mockResolvedValue({ ok: false, status: 429 });

    await expect(answerDraftTransport(channel("private"), context()).typing()).rejects.toMatchObject({
      code: "AGENT_TELEGRAM_TYPING_REJECTED",
      details: { providerStatus: 429 },
    });
  });
});
