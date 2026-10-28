/**
 * Reply buttons on the messages they go out with.
 *
 * Constructs covered:
 * - Buttons the model wrote are recorded with the exact text of the last message, written into it
 *   as Telegram markup with the set's own token, and activated under the delivered message.
 * - Buttons go only to the person the turn answers, in the chat of the turn, outside external
 *   groups; refused markup and buttons in an interim note are reported, never delivered.
 * - Any failure of their bookkeeping lets the answer or the reminder go out without them, and so
 *   does Telegram refusing the message that carries them: it goes again without the buttons, which
 *   are discarded and never activated. Any other failure of the send is not retried.
 * - A reminder's buttons ride on a rich message that keeps its text literal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";

const REFUSAL = new AppError("AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_FAILED", "Telegram не принял форматированный ответ", {
  details: { description: "Bad Request: BUTTON_TEXT_INVALID", providerStatus: 400 },
});
const SENT = { chatType: "private" as const, messageId: "601" };

const repository = vi.hoisted(() => ({
  activate: vi.fn(),
  activateForTurn: vi.fn(),
  discard: vi.fn(),
  stageForReminder: vi.fn(),
  stageForTurn: vi.fn(),
}));
vi.mock("./reply-button-repository.js", () => ({ replyButtonRepository: repository }));

const { reminderReplyButtons, reportUndeliveredReplyButtons, turnReplyButtons } = await import("./reply-button-delivery.js");

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const ROWS = [[{ color: "green" as const, text: "✅ Да" }, { text: "Нет" }]];
const SET = { buttons: ROWS, id: "set-1", token: TOKEN };
const ATTRIBUTES = { telegramChatId: "101", telegramChatType: "private", telegramUserId: "101" };
const TURN = {
  agentSessionId: "session-1",
  agentTurnId: "turn-1",
  attributes: ATTRIBUTES,
  found: { error: null, rows: ROWS },
  telegramChatId: "101",
};
const CHUNK = { format: "rich" as const, text: "Оформляем?" };
const MARKUP = `<tg-button-row><tg-button type="callback_data" data="rb:${TOKEN}:0" style="success">✅ Да</tg-button>` +
  `<tg-button type="callback_data" data="rb:${TOKEN}:1">Нет</tg-button></tg-button-row>`;

afterEach(() => {
  vi.restoreAllMocks();
});

function loggedCodes(): unknown[] {
  return vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(String(line)).code);
}

describe("reply buttons on a turn's final answer", () => {
  beforeEach(() => {
    for (const fn of Object.values(repository)) fn.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("records the last message, writes the buttons into it and activates them under it", async () => {
    repository.stageForTurn.mockResolvedValue(SET);
    const attachment = turnReplyButtons(TURN)!;
    const post = vi.fn().mockResolvedValue(SENT);

    await expect(attachment.sendLast(CHUNK, post)).resolves.toBe(SENT);
    await attachment.afterDelivery([{ messageId: "600" }, { messageId: "601" }]);

    expect(post.mock.calls).toEqual([[`Оформляем?\n\n${MARKUP}`]]);

    expect(repository.stageForTurn).toHaveBeenCalledWith({
      addresseeTelegramUserId: "101",
      agentSessionId: "session-1",
      agentTurnId: "turn-1",
      buttons: ROWS,
      messageText: "Оформляем?",
      telegramChatId: "101",
      telegramChatType: "private",
      token: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u),
    });
    expect(repository.activateForTurn).toHaveBeenCalledWith("turn-1", "601", []);
  });

  it("keeps the files of the message its buttons went out under", async () => {
    const media = [{ fileId: "photo-file", id: "f0", kind: "photo" as const }];

    await turnReplyButtons(TURN)!.afterDelivery([{ messageId: "600" }, { media, messageId: "601" }]);

    expect(repository.activateForTurn).toHaveBeenCalledWith("turn-1", "601", media);
  });

  it("activates the buttons of an answer whose delivery a replay found already done", async () => {
    await turnReplyButtons(TURN)!.afterDelivery([{ messageId: "601" }]);

    expect(repository.stageForTurn).not.toHaveBeenCalled();
    expect(repository.activateForTurn).toHaveBeenCalledWith("turn-1", "601", []);
  });

  it("offers no buttons when the turn wrote none", () => {
    expect(turnReplyButtons({ ...TURN, found: undefined })).toBeNull();
  });

  it("reports refused markup and delivers the answer without buttons", () => {
    const error = new AppError("AGENT_REPLY_BUTTONS_INVALID", "Нужно от 1 до 6 кнопок");

    expect(turnReplyButtons({ ...TURN, found: { error, rows: null } })).toBeNull();
    expect(loggedCodes()).toEqual(["AGENT_REPLY_BUTTONS_REFUSED"]);
  });

  it.each([
    ["an external group", { ...ATTRIBUTES, groupType: "external", telegramChatType: "supergroup" }],
    ["a group of no known kind", { ...ATTRIBUTES, telegramChatType: "supergroup" }],
    ["a channel", { ...ATTRIBUTES, telegramChatType: "channel" }],
    ["no person to answer", { telegramChatId: "101", telegramChatType: "private" }],
    ["an owner placeholder", { ...ATTRIBUTES, telegramUserId: "owner-private" }],
    ["another chat", { ...ATTRIBUTES, telegramChatId: "202" }],
  ])("offers no buttons in %s", (_case, attributes) => {
    expect(turnReplyButtons({ ...TURN, attributes })).toBeNull();
    expect(loggedCodes()).toEqual(["AGENT_REPLY_BUTTONS_TARGET_INVALID"]);
  });

  it("sends the last message without buttons when they cannot be recorded", async () => {
    repository.stageForTurn.mockRejectedValue(new Error("database busy"));
    const post = vi.fn().mockResolvedValue(SENT);

    await turnReplyButtons(TURN)!.sendLast(CHUNK, post);

    expect(post.mock.calls).toEqual([["Оформляем?"]]);
    expect(loggedCodes()).toEqual(["AGENT_REPLY_BUTTONS_STAGING_FAILED"]);
  });

  it("sends the message again without buttons when Telegram refuses it, and never activates them", async () => {
    repository.stageForTurn.mockResolvedValue(SET);
    const attachment = turnReplyButtons(TURN)!;
    const post = vi.fn().mockRejectedValueOnce(REFUSAL).mockResolvedValueOnce(SENT);

    await expect(attachment.sendLast(CHUNK, post)).resolves.toBe(SENT);
    await attachment.afterDelivery([SENT]);

    expect(post.mock.calls).toEqual([[`Оформляем?\n\n${MARKUP}`], ["Оформляем?"]]);
    expect(repository.discard).toHaveBeenCalledWith("set-1");
    expect(repository.activateForTurn).not.toHaveBeenCalled();
    const logged = vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toEqual([{ agentTurnId: "turn-1", code: "AGENT_REPLY_BUTTONS_REJECTED" }]);
  });

  it("still sends the message without buttons when discarding them fails", async () => {
    repository.stageForTurn.mockResolvedValue(SET);
    repository.discard.mockRejectedValue(new Error("database busy"));
    const attachment = turnReplyButtons(TURN)!;
    const post = vi.fn().mockRejectedValueOnce(REFUSAL).mockResolvedValueOnce(SENT);

    await expect(attachment.sendLast(CHUNK, post)).resolves.toBe(SENT);
    await attachment.afterDelivery([SENT]);

    expect(repository.activateForTurn).not.toHaveBeenCalled();
    expect(loggedCodes()).toEqual(["AGENT_REPLY_BUTTONS_REJECTED", "AGENT_REPLY_BUTTONS_DISCARD_FAILED"]);
  });

  it("does not send again after any other failure, whose outcome may be a delivered message", async () => {
    repository.stageForTurn.mockResolvedValue(SET);
    const ambiguous = new AppError("AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS", "Telegram не подтвердил сообщение");
    const limited = new AppError("AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_FAILED", "Telegram не принял форматированный ответ", {
      details: { providerStatus: 429 },
    });

    for (const failure of [ambiguous, limited]) {
      const post = vi.fn().mockRejectedValue(failure);
      await expect(turnReplyButtons(TURN)!.sendLast(CHUNK, post)).rejects.toBe(failure);
      expect(post).toHaveBeenCalledTimes(1);
    }
    expect(repository.discard).not.toHaveBeenCalled();
  });

  it("offers buttons in a family group to the member the turn answers", () => {
    const attributes = { ...ATTRIBUTES, groupType: "family_private", telegramChatId: "-100777", telegramChatType: "supergroup" };

    expect(turnReplyButtons({ ...TURN, attributes, telegramChatId: "-100777" })).not.toBeNull();
  });

  it("sends a last message without buttons when they would not fit in it", async () => {
    const post = vi.fn().mockResolvedValue(SENT);
    const text = "я".repeat(32_700);

    await turnReplyButtons(TURN)!.sendLast({ format: "rich", text }, post);

    expect(post.mock.calls).toEqual([[text]]);
    expect(repository.stageForTurn).not.toHaveBeenCalled();
    expect(loggedCodes()).toEqual(["AGENT_REPLY_BUTTONS_TOO_LARGE"]);
  });

  it("keeps a delivered answer delivered when activation fails", async () => {
    repository.stageForTurn.mockResolvedValue(SET);
    repository.activateForTurn.mockRejectedValue(new Error("database busy"));
    const attachment = turnReplyButtons(TURN)!;
    await attachment.sendLast(CHUNK, vi.fn().mockResolvedValue(SENT));

    await expect(attachment.afterDelivery([{ messageId: "600" }])).resolves.toBeUndefined();
    expect(loggedCodes()).toEqual(["AGENT_REPLY_BUTTONS_ACTIVATION_FAILED"]);
  });

  it("reports buttons an interim note carried", () => {
    reportUndeliveredReplyButtons({ error: null, rows: ROWS }, { agentTurnId: "turn-1" });
    reportUndeliveredReplyButtons(undefined, { agentTurnId: "turn-1" });

    expect(loggedCodes()).toEqual(["AGENT_REPLY_BUTTONS_OUTSIDE_ANSWER"]);
  });
});

describe("reply buttons on a reminder", () => {
  const REMINDER = {
    addresseeTelegramUserId: "101", buttons: ROWS, content: "Оплатить <интернет> & *ТВ*\nдо 20:00",
    delayedNotice: null, reminderId: "reminder-1", scope: "personal" as const, telegramChatId: "101",
    telegramChatType: "private",
  };

  beforeEach(() => {
    for (const fn of Object.values(repository)) fn.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("stages the reminder's text and returns it as a rich message with its buttons", async () => {
    repository.stageForReminder.mockResolvedValue(SET);

    const buttons = await reminderReplyButtons(REMINDER);

    const text = "**⏰ Напоминание:**\n\n<p>Оплатить &lt;интернет&gt; &amp; *ТВ*<br>до 20:00</p>";
    expect(repository.stageForReminder).toHaveBeenCalledWith({
      addresseeTelegramUserId: "101",
      buttons: ROWS,
      messageText: text,
      reminderId: "reminder-1",
      telegramChatId: "101",
      telegramChatType: "private",
      token: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u),
    });
    expect(buttons?.markdown).toBe(`${text}\n\n${MARKUP}`);
  });

  it("adds the late-delivery notice as its own paragraph", async () => {
    repository.stageForReminder.mockResolvedValue(SET);

    await reminderReplyButtons({ ...REMINDER, content: "Позвонить", delayedNotice: "Доставлено с задержкой." });

    expect(repository.stageForReminder).toHaveBeenCalledWith(expect.objectContaining({
      messageText: "**⏰ Напоминание:**\n\n<p>Позвонить</p>\n\n<p>Доставлено с задержкой.</p>",
    }));
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
