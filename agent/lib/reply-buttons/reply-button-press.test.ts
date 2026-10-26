/**
 * Reply button press tests.
 *
 * Constructs covered:
 * - A press by anyone but the addressee, or on buttons that no longer stand, is answered with a
 *   pop-up and continues as nothing.
 * - The addressee's press is answered, the message gets the choice as a caption, and the press
 *   continues as the addressee's message quoting the message it was made under.
 * - In a private chat that message replies to the buttons' message only when a conversation owns
 *   that message, otherwise it goes to the main conversation; in a group it always replies, which
 *   addresses it to the agent there.
 * - A replayed press rebuilds the same message without touching Telegram again.
 */
import { describe, expect, it, vi } from "vitest";

import { parseTelegramUpdate, type TelegramCallbackQuery } from "../../runtime/telegram/inbound.js";
import { createReplyButtonPressHandler, REPLY_BUTTON_PRESS_MESSAGE_ID_BASE } from "./reply-button-press.js";
import type { ReplyButtonSet } from "./reply-button-repository.js";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const PRESSED_AT = new Date("2026-10-26T12:00:05.000Z");

function press(input: { chat?: Record<string, unknown>; data?: string; from?: number } = {}): TelegramCallbackQuery {
  const chat = input.chat ?? { id: 101, type: "private" };
  const update = parseTelegramUpdate({
    callback_query: {
      data: input.data ?? `rb:${TOKEN}:0`,
      from: { first_name: "Андрей", id: input.from ?? 101, is_bot: false },
      id: "cb-1",
      message: {
        chat,
        date: 1_793_000_000,
        from: { first_name: "Осинара", id: 999, is_bot: true, username: "osinara_bot" },
        message_id: 50,
        text: "Корзина собрана. Итого 2 340 ₽. Оформляем?",
      },
    },
    update_id: 7001,
  });
  if (update?.kind !== "callback_query") throw new Error("TEST_CALLBACK_INVALID");
  return update.callbackQuery;
}

function selected(overrides: Partial<ReplyButtonSet> = {}): ReplyButtonSet {
  return {
    addresseeTelegramUserId: "101",
    buttons: [[{ color: "green", text: "✅ Да, заказываем" }, { text: "❌ Отмена" }]],
    id: "set-1",
    messageEntities: null,
    messageFormat: "plain",
    messageText: "Корзина собрана. Итого 2 340 ₽. Оформляем?",
    resolvedAt: PRESSED_AT,
    selectedIndex: 0,
    telegramChatId: "101",
    telegramChatType: "private",
    telegramMessageId: "50",
    token: TOKEN,
    ...overrides,
  };
}

function handler(claim: unknown, routed = false) {
  const repository = { claimPress: vi.fn().mockResolvedValue(claim) };
  const routes = { hasRoute: vi.fn().mockResolvedValue(routed) };
  const telegram = { answerPress: vi.fn().mockResolvedValue(undefined), settle: vi.fn().mockResolvedValue(undefined) };
  return { handle: createReplyButtonPressHandler({ repository, routes, telegram }), repository, routes, telegram };
}

describe("reply button press", () => {
  it.each([
    ["forbidden", "Эти кнопки предназначены не вам"],
    ["expired", "Эти кнопки уже не действуют"],
  ])("answers a %s press with a pop-up and starts nothing", async (status, text) => {
    const { handle, telegram } = handler({ status });

    await expect(handle(press({ from: 202 }), "7001")).resolves.toEqual({ status: "answered" });

    expect(telegram.answerPress).toHaveBeenCalledWith({ callbackQueryId: "cb-1", text });
    expect(telegram.settle).not.toHaveBeenCalled();
  });

  it("claims exactly the pressed button for the presser in the pressed message", async () => {
    const { handle, repository } = handler({ set: selected(), status: "claimed" });

    await handle(press({ data: `rb:${TOKEN}:1` }), "7001");

    expect(repository.claimPress).toHaveBeenCalledWith({
      callbackQueryId: "cb-1", index: 1, pressedByTelegramUserId: "101",
      telegramChatId: "101", telegramMessageId: "50", token: TOKEN,
    });
  });

  it("does not consult storage for data it could not have produced", async () => {
    const { handle, repository, telegram } = handler({ status: "expired" });

    await expect(handle(press({ data: "rb:short:0" }), "7001")).resolves.toEqual({ status: "answered" });

    expect(repository.claimPress).not.toHaveBeenCalled();
    expect(telegram.answerPress).toHaveBeenCalledWith({ callbackQueryId: "cb-1", text: "Эти кнопки уже не действуют" });
  });

  it("turns a private press under a message no conversation owns into a message of the main one", async () => {
    const { handle, routes, telegram } = handler({ set: selected(), status: "claimed" });

    const outcome = await handle(press(), "7001");

    expect(routes.hasRoute).toHaveBeenCalledWith("101::50");
    expect(telegram.answerPress).toHaveBeenCalledWith({ callbackQueryId: "cb-1" });
    expect(telegram.settle).toHaveBeenCalledWith(selected(), "Выбрано: ✅ Да, заказываем");
    if (outcome.status !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
    expect(outcome.buttonMessageId).toBe("50");
    expect(outcome.message).toMatchObject({
      chat: { id: "101", type: "private" },
      from: { id: "101", isBot: false },
      messageId: String(REPLY_BUTTON_PRESS_MESSAGE_ID_BASE + 7001),
      text: "[Tapped button «✅ Да, заказываем» under your message: «Корзина собрана. Итого 2 340 ₽. Оформляем?»]",
    });
    expect(outcome.message.replyToMessage).toBeUndefined();
    expect(outcome.message.raw.date).toBe(PRESSED_AT.getTime() / 1_000);
  });

  it("answers a private press as a reply when a conversation owns the buttons' message", async () => {
    const { handle } = handler({ set: selected(), status: "claimed" }, true);

    const outcome = await handle(press(), "7001");

    if (outcome.status !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
    expect(outcome.message.replyToMessage).toMatchObject({ messageId: "50" });
  });

  it("replies to the buttons' message in a group and names the presser in the caption", async () => {
    const chat = { id: -100777, title: "Семья", type: "supergroup" };
    const set = selected({ telegramChatId: "-100777", telegramChatType: "supergroup" });
    const { handle, telegram } = handler({ set, status: "claimed" });

    const outcome = await handle(press({ chat }), "7001");

    expect(telegram.settle).toHaveBeenCalledWith(set, "Выбрано: ✅ Да, заказываем (Андрей)");
    if (outcome.status !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
    expect(outcome.message.replyToMessage).toMatchObject({ from: { isBot: true }, messageId: "50" });
  });

  it("quotes a long message briefly and on one line", async () => {
    const set = selected({ messageText: `Первая строка\n\n${"очень ".repeat(80)}конец` });
    const { handle } = handler({ set, status: "claimed" });

    const outcome = await handle(press(), "7001");

    if (outcome.status !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
    expect(outcome.message.text).toMatch(/^\[Tapped button «✅ Да, заказываем» under your message: «Первая строка очень .+…»\]$/u);
    expect(outcome.message.text).not.toContain("конец");
  });

  it("rebuilds a replayed press without answering or editing again", async () => {
    const { handle, telegram } = handler({ set: selected(), status: "replayed" });

    const first = await handle(press(), "7001");
    const second = await handle(press(), "7001");

    expect(second).toEqual(first);
    expect(telegram.answerPress).not.toHaveBeenCalled();
    expect(telegram.settle).not.toHaveBeenCalled();
  });

  it("still continues the recorded choice when Telegram refuses the caption", async () => {
    const { handle, telegram } = handler({ set: selected(), status: "claimed" });
    telegram.settle.mockRejectedValue(new Error("message to edit not found"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(handle(press(), "7001")).resolves.toMatchObject({ status: "message" });
    vi.restoreAllMocks();
  });
});
