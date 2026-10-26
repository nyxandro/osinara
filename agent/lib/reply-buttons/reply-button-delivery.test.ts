/**
 * Reply buttons on the messages they go out with.
 *
 * Constructs covered:
 * - Staged buttons give the last message its keyboard and are activated under it.
 * - Any failure of their bookkeeping lets the answer or the reminder go out without them.
 * - Buttons staged for another chat, or a reminder without a known addressee, send none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  activate: vi.fn(),
  findStagedForTurn: vi.fn(),
  recordMessageText: vi.fn(),
  stageForReminder: vi.fn(),
}));
vi.mock("./reply-button-repository.js", () => ({ replyButtonRepository: repository }));

const { reminderReplyButtons, stagedReplyButtons } = await import("./reply-button-delivery.js");

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const SET = { buttons: [[{ text: "✅ Да" }]], id: "set-1", telegramChatId: "101", token: TOKEN };
const CHUNK = { format: "plain" as const, text: "Оформляем?" };
const REMINDER = {
  addresseeTelegramUserId: "101", buttons: [[{ text: "✅ Оплатил" }]], messageEntities: [], messageText: "⏰ Напоминание:",
  reminderId: "reminder-1", scope: "personal" as const, telegramChatId: "101", telegramChatType: "private",
};

describe("reply buttons on a turn's final answer", () => {
  beforeEach(() => {
    for (const fn of Object.values(repository)) fn.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("gives the last message its keyboard and activates it under that message", async () => {
    repository.findStagedForTurn.mockResolvedValue(SET);
    const attachment = await stagedReplyButtons({ agentTurnId: "turn-1", telegramChatId: "101" });

    await expect(attachment!.prepareLastChunk(CHUNK)).resolves.toEqual({
      inline_keyboard: [[{ callback_data: `rb:${TOKEN}:0`, text: "✅ Да" }]],
    });
    await attachment!.afterDelivery([{ messageId: "600" }, { messageId: "601" }]);

    expect(repository.recordMessageText).toHaveBeenCalledWith("set-1", "Оформляем?", "plain");
    expect(repository.activate).toHaveBeenCalledWith("set-1", "601");
  });

  it("sends the answer without buttons staged for another chat or when they cannot be read", async () => {
    repository.findStagedForTurn.mockResolvedValueOnce({ ...SET, telegramChatId: "202" });
    await expect(stagedReplyButtons({ agentTurnId: "turn-1", telegramChatId: "101" })).resolves.toBeNull();

    repository.findStagedForTurn.mockRejectedValueOnce(new Error("database busy"));
    await expect(stagedReplyButtons({ agentTurnId: "turn-1", telegramChatId: "101" })).resolves.toBeNull();
  });

  it("sends the last message without a keyboard when its text cannot be recorded, and activates nothing", async () => {
    repository.findStagedForTurn.mockResolvedValue(SET);
    repository.recordMessageText.mockRejectedValue(new Error("database busy"));
    const attachment = await stagedReplyButtons({ agentTurnId: "turn-1", telegramChatId: "101" });

    await expect(attachment!.prepareLastChunk(CHUNK)).resolves.toBeUndefined();
    await attachment!.afterDelivery([{ messageId: "600" }]);

    expect(repository.activate).not.toHaveBeenCalled();
  });

  it("keeps a delivered answer delivered when activation fails", async () => {
    repository.findStagedForTurn.mockResolvedValue(SET);
    repository.activate.mockRejectedValue(new Error("database busy"));
    const attachment = await stagedReplyButtons({ agentTurnId: "turn-1", telegramChatId: "101" });
    await attachment!.prepareLastChunk(CHUNK);

    await expect(attachment!.afterDelivery([{ messageId: "600" }])).resolves.toBeUndefined();
  });
});

describe("reply buttons on a reminder", () => {
  beforeEach(() => {
    for (const fn of Object.values(repository)) fn.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("stages the reminder's buttons and returns its keyboard", async () => {
    repository.stageForReminder.mockResolvedValue(SET);

    const buttons = await reminderReplyButtons(REMINDER);

    expect(buttons?.replyMarkup).toEqual({ inline_keyboard: [[{ callback_data: `rb:${TOKEN}:0`, text: "✅ Да" }]] });
  });

  it.each([
    ["no buttons", { buttons: null }],
    ["a group-chat reminder", { scope: "group" as const }],
    ["no known addressee", { addresseeTelegramUserId: null }],
    ["an unknown chat type", { telegramChatType: null }],
  ])("delivers without buttons for %s", async (_case, overrides) => {
    await expect(reminderReplyButtons({ ...REMINDER, ...overrides })).resolves.toBeNull();
    expect(repository.stageForReminder).not.toHaveBeenCalled();
  });

  it("delivers without buttons when they cannot be staged", async () => {
    repository.stageForReminder.mockRejectedValue(new Error("database busy"));

    await expect(reminderReplyButtons(REMINDER)).resolves.toBeNull();
  });
});
