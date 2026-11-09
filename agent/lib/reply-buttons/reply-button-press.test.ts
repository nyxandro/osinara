/**
 * Reply button press tests.
 *
 * Constructs covered:
 * - On arrival, before the chat queue: a press by anyone but the addressee, or on buttons that no
 *   longer stand, gets a pop-up; the addressee's press is recorded, answered and its message gets
 *   the choice as a caption. A press someone already claimed is left alone.
 * - In the chat queue the press continues as the addressee's message quoting the message it was
 *   made under, without answering Telegram again; only a press nobody claimed on arrival is
 *   answered and captioned there.
 * - In a private chat that message replies to the buttons' message only when a conversation owns
 *   that message and takes replies, otherwise it goes to the main conversation; in a group it always
 *   replies, which addresses it to the agent there.
 * - A replayed press rebuilds the same message and settles its buttons again without answering
 *   Telegram twice; a press on buttons already decided settles them again on arrival, naming the
 *   presser in a group.
 * - A scenario's read button (#480) skips its scenario for the day with the recorded moments of the
 *   message and the press, answers with a pop-up, writes «✅ Прочитано в …» and never becomes a
 *   message; a card of an earlier day or of a deleted scenario says so; a skip that failed on
 *   arrival is finished by the queue step.
 */
import { describe, expect, it, vi } from "vitest";

import { parseTelegramUpdate, type TelegramCallbackQuery } from "../../runtime/telegram/inbound.js";
import { AppError } from "../app-error.js";
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

const SENT_AT = new Date("2026-10-26T04:30:00.000Z");
const SCHEDULE_ID = "0f398fc5-e589-4e66-bf52-8db8aa3f7251";

function selected(overrides: Partial<ReplyButtonSet> = {}): ReplyButtonSet {
  return {
    activatedAt: SENT_AT,
    addresseeTelegramUserId: "101",
    createdAt: SENT_AT,
    buttons: [[{ color: "green", text: "✅ Да, заказываем" }, { text: "❌ Отмена" }]],
    id: "set-1",
    messageFormat: "rich",
    messageMedia: [],
    messageText: "Корзина собрана. Итого 2 340 ₽. Оформляем?",
    resolvedAt: PRESSED_AT,
    selectedIndex: 0,
    status: "selected",
    telegramChatId: "101",
    telegramChatType: "private",
    telegramMessageId: "50",
    token: TOKEN,
    ...overrides,
  };
}

function handler(claim: unknown, routeOpen = false, skip: unknown = { kind: "skipped", localTime: "15:00", title: "Контроль задач" }) {
  const repository = {
    claimPress: vi.fn().mockResolvedValue(claim),
    replyRouteIsOpen: vi.fn().mockResolvedValue(routeOpen),
  };
  const skipSchedule = skip instanceof Error ? vi.fn().mockRejectedValue(skip) : vi.fn().mockResolvedValue(skip);
  const telegram = { answerPress: vi.fn().mockResolvedValue(undefined), settle: vi.fn().mockResolvedValue(undefined) };
  const pressHandler = createReplyButtonPressHandler({ repository, skipSchedule, telegram });
  return { acknowledge: pressHandler.acknowledge, handle: pressHandler.continueAsMessage, repository, skipSchedule, telegram };
}

const READ_SET = { buttons: [[{ color: "green" as const, skipScheduleId: SCHEDULE_ID, text: "✅ Задачи на день услышаны" }]] };

describe("a scenario's read button (#480)", () => {
  it("skips the scenario for the day on arrival, answers with a pop-up and writes the time", async () => {
    const { acknowledge, skipSchedule, telegram } = handler({ set: selected(READ_SET), status: "claimed" });

    await acknowledge(press(), "7001");

    expect(skipSchedule).toHaveBeenCalledWith({
      addresseeTelegramUserId: "101",
      pressedAt: PRESSED_AT,
      scheduleId: SCHEDULE_ID,
      sentAt: SENT_AT,
      telegramChatId: "101",
    });
    expect(telegram.answerPress).toHaveBeenCalledWith({ callbackQueryId: "cb-1", text: "Прочитано. Повторы на сегодня сняты" });
    expect(telegram.settle).toHaveBeenCalledWith(expect.objectContaining({ id: "set-1" }), "✅ Прочитано в 15:00");
  });

  it("never turns the press into a message for the model", async () => {
    const { handle, telegram } = handler({ set: selected(READ_SET), status: "replayed" });

    await expect(handle(press(), "7001")).resolves.toEqual({ status: "answered" });
    expect(telegram.answerPress).not.toHaveBeenCalled();
    expect(telegram.settle).toHaveBeenCalledWith(expect.anything(), "✅ Прочитано в 15:00");
  });

  it.each([
    ["stale", "Не засчитано: эта карточка за прошлый день"],
    ["missing", "Не засчитано: этого сценария больше нет"],
  ] as const)("says so when the press cannot count (%s)", async (kind, line) => {
    const { acknowledge, telegram } = handler({ set: selected(READ_SET), status: "claimed" }, false, { kind });

    await acknowledge(press(), "7001");

    expect(telegram.answerPress).toHaveBeenCalledWith({ callbackQueryId: "cb-1", text: line });
    expect(telegram.settle).toHaveBeenCalledWith(expect.anything(), line);
  });

  it("stops the spinner and leaves the skip to the queue step when it fails on arrival", async () => {
    const failing = handler({ set: selected(READ_SET), status: "claimed" }, false, new Error("database unavailable"));

    await failing.acknowledge(press(), "7001");

    expect(failing.telegram.answerPress).toHaveBeenCalledWith({ callbackQueryId: "cb-1" });
    expect(failing.telegram.settle).not.toHaveBeenCalled();

    const queue = handler({ set: selected(READ_SET), status: "replayed" });
    await expect(queue.handle(press(), "7001")).resolves.toEqual({ status: "answered" });
    expect(queue.skipSchedule).toHaveBeenCalledTimes(1);
    expect(queue.telegram.settle).toHaveBeenCalledWith(expect.anything(), "✅ Прочитано в 15:00");
  });

  it("leaves an ordinary answer button to the model without touching any scenario", async () => {
    const { handle, skipSchedule } = handler({ set: selected(), status: "claimed" });

    await expect(handle(press(), "7001")).resolves.toMatchObject({ status: "message" });
    expect(skipSchedule).not.toHaveBeenCalled();
  });
});

describe("reply button press on arrival", () => {
  it.each([
    ["forbidden", "Эти кнопки предназначены не вам"],
    ["expired", "Эти кнопки уже не действуют"],
  ])("answers a %s press with a pop-up", async (status, text) => {
    const { acknowledge, telegram } = handler({ status });

    await acknowledge(press({ from: 202 }), "7001");

    expect(telegram.answerPress).toHaveBeenCalledWith({ callbackQueryId: "cb-1", text });
    expect(telegram.settle).not.toHaveBeenCalled();
  });

  it("answers the addressee's press at once and puts the choice in place of the buttons", async () => {
    const { acknowledge, telegram } = handler({ set: selected(), status: "claimed" });

    await acknowledge(press(), "7001");

    expect(telegram.answerPress).toHaveBeenCalledWith({ callbackQueryId: "cb-1" });
    expect(telegram.settle).toHaveBeenCalledWith(selected(), "Выбрано: ✅ Да, заказываем");
  });

  it("names the presser in a group caption", async () => {
    const set = selected({ telegramChatId: "-100777", telegramChatType: "supergroup" });
    const { acknowledge, telegram } = handler({ set, status: "claimed" });

    await acknowledge(press({ chat: { id: -100777, title: "Семья", type: "supergroup" } }), "7001");

    expect(telegram.settle).toHaveBeenCalledWith(set, "Выбрано: ✅ Да, заказываем (Андрей)");
  });

  it("does not answer a press someone already claimed, and only settles its buttons again", async () => {
    const { acknowledge, telegram } = handler({ set: selected(), status: "replayed" });

    await acknowledge(press(), "7001");

    expect(telegram.answerPress).not.toHaveBeenCalled();
    expect(telegram.settle).toHaveBeenCalledWith(selected(), "Выбрано: ✅ Да, заказываем");
  });

  it("keeps the presser's name when buttons already chosen in a group are pressed again", async () => {
    const decided = selected({ telegramChatId: "-100777", telegramChatType: "supergroup" });
    const { acknowledge, telegram } = handler({ decided, status: "expired" });

    await acknowledge(press({ chat: { id: -100777, title: "Семья", type: "supergroup" } }), "7001");

    expect(telegram.settle).toHaveBeenCalledWith(decided, "Выбрано: ✅ Да, заказываем (Андрей)");
  });

  it("answers data it could not have produced without consulting storage", async () => {
    const { acknowledge, repository, telegram } = handler({ status: "expired" });

    await acknowledge(press({ data: "rb:short:0" }), "7001");

    expect(repository.claimPress).not.toHaveBeenCalled();
    expect(telegram.answerPress).toHaveBeenCalledWith({ callbackQueryId: "cb-1", text: "Эти кнопки уже не действуют" });
  });

  it.each([
    ["selected", { selectedIndex: 1, status: "selected" }, "Выбрано: ❌ Отмена"],
    ["dismissed", { selectedIndex: null, status: "dismissed" }, "Ничего не выбрано"],
  ] as const)("settles buttons already %s when one of them is pressed again", async (_case, overrides, caption) => {
    const decided = selected(overrides);
    const { acknowledge, telegram } = handler({ decided, status: "expired" });

    await acknowledge(press(), "7001");

    expect(telegram.answerPress).toHaveBeenCalledWith({ callbackQueryId: "cb-1", text: "Эти кнопки уже не действуют" });
    expect(telegram.settle).toHaveBeenCalledWith(decided, caption);
  });

  it("keeps the recorded choice when Telegram refuses the answer or the caption", async () => {
    const { acknowledge, telegram } = handler({ set: selected(), status: "claimed" });
    telegram.answerPress.mockRejectedValue(new Error("query is too old"));
    telegram.settle.mockRejectedValue(new Error("message to edit not found"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(acknowledge(press(), "7001")).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });

  it("logs Telegram's own reason for a refused answer and caption", async () => {
    const { acknowledge, telegram } = handler({ set: selected(), status: "claimed" });
    telegram.answerPress.mockRejectedValue(new AppError("AGENT_REPLY_BUTTON_ANSWER_FAILED", "Telegram не принял ответ", {
      details: { description: "Bad Request: query is too old", status: 400 },
    }));
    telegram.settle.mockRejectedValue(new AppError("AGENT_REPLY_BUTTONS_SETTLE_FAILED", "Telegram не убрал кнопки", {
      details: { description: "Bad Request: message to edit not found", status: 400, telegramMessageId: "50" },
    }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await acknowledge(press(), "7001");

    const records = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "AGENT_REPLY_BUTTON_ANSWER_FAILED",
        details: { description: "Bad Request: query is too old", status: 400 },
      }),
      expect.objectContaining({
        code: "AGENT_REPLY_BUTTONS_SETTLE_FAILED",
        details: { description: "Bad Request: message to edit not found", status: 400, telegramMessageId: "50" },
        setId: "set-1",
      }),
    ]));
    vi.restoreAllMocks();
  });
});

describe("reply button press in the chat queue", () => {
  it.each(["forbidden", "expired"])("starts nothing for a %s press and leaves its pop-up to the arrival", async (status) => {
    const { handle, telegram } = handler({ status });

    await expect(handle(press({ from: 202 }), "7001")).resolves.toEqual({ status: "answered" });

    expect(telegram.answerPress).not.toHaveBeenCalled();
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
    expect(telegram.answerPress).not.toHaveBeenCalled();
  });

  it("turns a private press under a message no conversation owns into a message of the main one", async () => {
    const { handle, repository, telegram } = handler({ set: selected(), status: "replayed" });

    const outcome = await handle(press(), "7001");

    expect(repository.replyRouteIsOpen).toHaveBeenCalledWith("101::50");
    // The arrival answered it; a crash before its caption is repaired here.
    expect(telegram.answerPress).not.toHaveBeenCalled();
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

  it("answers a private press as a reply when an open conversation owns the buttons' message", async () => {
    const { handle } = handler({ set: selected(), status: "claimed" }, true);

    const outcome = await handle(press(), "7001");

    if (outcome.status !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
    expect(outcome.message.replyToMessage).toMatchObject({ messageId: "50" });
  });

  it("answers and captions a press nobody claimed on arrival before it continues", async () => {
    const { handle, telegram } = handler({ set: selected(), status: "claimed" });

    await expect(handle(press(), "7001")).resolves.toMatchObject({ status: "message" });

    expect(telegram.answerPress).toHaveBeenCalledWith({ callbackQueryId: "cb-1" });
    expect(telegram.settle).toHaveBeenCalledWith(selected(), "Выбрано: ✅ Да, заказываем");
  });

  it("replies to the buttons' message in a group", async () => {
    const chat = { id: -100777, title: "Семья", type: "supergroup" };
    const set = selected({ telegramChatId: "-100777", telegramChatType: "supergroup" });
    const { handle } = handler({ set, status: "replayed" });

    const outcome = await handle(press({ chat }), "7001");

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

  it("quotes the words of the message, not its markup", async () => {
    const set = selected({ messageText: "**⏰ Напоминание:**\n\n<p>Оплатить &amp; &lt;быстро&gt;<br>до вечера</p>" });
    const { handle } = handler({ set, status: "replayed" });

    const outcome = await handle(press(), "7001");

    if (outcome.status !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
    expect(outcome.message.text).toBe(
      "[Tapped button «✅ Да, заказываем» under your message: «**⏰ Напоминание:** Оплатить & <быстро> до вечера»]",
    );
  });

  it("keeps comparison signs of the text when it drops the markup", async () => {
    const set = selected({ messageText: "Если `a < b`, то **всё** ок, иначе `c > d` — берём?" });
    const { handle } = handler({ set, status: "replayed" });

    const outcome = await handle(press(), "7001");

    if (outcome.status !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
    expect(outcome.message.text).toContain("«Если `a < b`, то **всё** ок, иначе `c > d` — берём?»");
  });

  it("rebuilds a replayed press into the same message", async () => {
    const { handle } = handler({ set: selected(), status: "replayed" });

    const first = await handle(press(), "7001");
    const second = await handle(press(), "7001");

    expect(second).toEqual(first);
  });

  it("still continues the recorded choice when Telegram refuses the caption", async () => {
    const { handle, telegram } = handler({ set: selected(), status: "claimed" });
    telegram.settle.mockRejectedValue(new Error("message to edit not found"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(handle(press(), "7001")).resolves.toMatchObject({ status: "message" });
    vi.restoreAllMocks();
  });
});
