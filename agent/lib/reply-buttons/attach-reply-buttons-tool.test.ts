/**
 * `attach_reply_buttons` tests.
 *
 * Constructs covered:
 * - Buttons are staged for the current turn, addressed to the person the turn answers.
 * - Outside a private chat or a family group the tool refuses before storing anything.
 * - Invalid rows reach the model as an actionable error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({ stageForTurn: vi.fn() }));
vi.mock("./reply-button-repository.js", () => ({ replyButtonRepository: repository }));

const { default: attachReplyButtons } = await import("../tools/attach_reply_buttons.js");

function context(attributes: Record<string, unknown>) {
  return {
    callId: "call-1",
    session: {
      auth: { current: { attributes, authenticator: "telegram", principalId: "user-1", principalType: "user" }, initiator: null },
      id: "wrun_session",
      turn: { id: "turn_1", sequence: 1 },
    },
  } as never;
}

const PRIVATE = { telegramChatId: "101", telegramChatType: "private", telegramUserId: "101" };
const ROWS = [[{ color: "green", text: "✅ Да" }, { color: "red", text: "❌ Нет" }]];

describe("attach_reply_buttons", () => {
  beforeEach(() => repository.stageForTurn.mockReset());

  it("stages the buttons of this turn for the person it answers", async () => {
    const result = await attachReplyButtons.execute({ rows: ROWS } as never, context(PRIVATE));

    expect(repository.stageForTurn).toHaveBeenCalledWith({
      addresseeTelegramUserId: "101",
      agentSessionId: "wrun_session",
      agentTurnId: "turn_1",
      buttons: ROWS,
      telegramChatId: "101",
      telegramChatType: "private",
      token: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u),
    });
    expect(result).toMatchObject({ buttons: ["✅ Да", "❌ Нет"], status: "attached" });
  });

  it("addresses a family group's buttons to the member the turn answers", async () => {
    await attachReplyButtons.execute({ rows: ROWS } as never, context({
      groupType: "family_private", telegramChatId: "-100777", telegramChatType: "supergroup", telegramUserId: "202",
    }));

    expect(repository.stageForTurn).toHaveBeenCalledWith(expect.objectContaining({
      addresseeTelegramUserId: "202", telegramChatId: "-100777", telegramChatType: "supergroup",
    }));
  });

  it.each([
    ["an external group", { groupType: "external", telegramChatId: "-100888", telegramChatType: "supergroup", telegramUserId: "202" }],
    ["a turn without a person", { telegramChatId: "101", telegramChatType: "private" }],
    ["a channel", { telegramChatId: "-100999", telegramChatType: "channel", telegramUserId: "202" }],
  ])("refuses %s before storing anything", async (_case, attributes) => {
    await expect(attachReplyButtons.execute({ rows: ROWS } as never, context(attributes)))
      .rejects.toMatchObject({ code: "AGENT_REPLY_BUTTONS_CONTEXT_INVALID" });
    expect(repository.stageForTurn).not.toHaveBeenCalled();
  });

  it("returns invalid rows to the model as an actionable error", async () => {
    await expect(attachReplyButtons.execute({ rows: [[{ text: "Да" }, { text: "да" }]] } as never, context(PRIVATE)))
      .rejects.toMatchObject({ code: "AGENT_REPLY_BUTTONS_INPUT_INVALID" });
    expect(repository.stageForTurn).not.toHaveBeenCalled();
  });
});
