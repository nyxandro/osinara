/**
 * Settling a message whose buttons were decided.
 *
 * Constructs covered:
 * - The edit rewrites the exact text the buttons went out with and puts the caption in their place;
 *   link and copy buttons stay under it.
 * - A message with files names each of them again by its Telegram file: Telegram refuses an edit
 *   of such a message that does not (RICH_MESSAGE_PHOTO_INVALID, tried in a live chat).
 * - A widget card's buttons are its keyboard (#480): the edit replaces the keyboard with the staying
 *   buttons and the caption as a disabled button, and leaves the card alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { replyButtonTelegram } from "./reply-button-telegram.js";

beforeEach(() => vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-bot-secret"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function editedBody() {
  const telegramFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
    JSON.stringify({ ok: true, result: true }),
    { headers: { "content-type": "application/json" }, status: 200 },
  ));
  return () => {
    const [url, init] = telegramFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telegram.org/bottelegram-bot-secret/editMessageText");
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
  };
}

describe("reply button settlement", () => {
  it("rewrites the message with the caption in place of its buttons", async () => {
    const body = editedBody();

    await replyButtonTelegram.settle({
      buttons: [[{ text: "✅ Да" }]], messageFormat: "rich", messageMedia: [], messageText: "Берём?", telegramChatId: "101", telegramMessageId: "50",
    }, "Выбрано: ✅ Да");

    expect(body()).toEqual({ chat_id: "101", message_id: 50, rich_message: { markdown: "Берём?\n\n_Выбрано: ✅ Да_" } });
  });

  it("keeps the link and copy buttons under the caption", async () => {
    const body = editedBody();

    await replyButtonTelegram.settle({
      buttons: [[{ text: "✅ Да" }, { text: "🌐 Меню", url: "https://example.com/menu" }], [{ copyText: "SUMMER25", text: "📋 Промокод" }]],
      messageFormat: "rich",
      messageMedia: [],
      messageText: "Промокод SUMMER25. Берём?",
      telegramChatId: "101",
      telegramMessageId: "50",
    }, "Выбрано: ✅ Да");

    expect(body()).toEqual({
      chat_id: "101",
      message_id: 50,
      rich_message: {
        markdown: "Промокод SUMMER25. Берём?\n\n_Выбрано: ✅ Да_\n\n" +
          "<tg-button-row><tg-button type=\"url\" url=\"https://example.com/menu\">🌐 Меню</tg-button></tg-button-row>\n" +
          "<tg-button-row><tg-button type=\"copy_text\" text=\"SUMMER25\">📋 Промокод</tg-button></tg-button-row>",
      },
    });
  });

  it("names every file of the message again", async () => {
    const body = editedBody();
    const messageText = "Рецепт\n\n![](tg://photo?id=f0 \"Обложка\")\n\n![](tg://document?id=f1)";

    await replyButtonTelegram.settle({
      buttons: [[{ text: "✅ Да" }]],
      messageFormat: "rich",
      messageMedia: [{ fileId: "photo-file", id: "f0", kind: "photo" }, { fileId: "document-file", id: "f1", kind: "document" }],
      messageText,
      telegramChatId: "101",
      telegramMessageId: "50",
    }, "Выбрано: ✅ Да");

    expect(body()).toEqual({
      chat_id: "101",
      message_id: 50,
      rich_message: {
        markdown: `${messageText}\n\n_Выбрано: ✅ Да_`,
        media: [
          { id: "f0", media: { media: "photo-file", type: "photo" } },
          { id: "f1", media: { media: "document-file", type: "document" } },
        ],
      },
    });
  });

  it("replaces a widget card's keyboard and leaves the card alone (#480)", async () => {
    const telegramFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ ok: true, result: true }),
      { headers: { "content-type": "application/json" }, status: 200 },
    ));

    await replyButtonTelegram.settle({
      buttons: [[{ color: "green", skipScheduleId: "0f398fc5-e589-4e66-bf52-8db8aa3f7251", text: "✅ Задачи на день услышаны" }], [{ text: "🌐 Меню", url: "https://example.com/menu" }]],
      messageFormat: "widget",
      messageMedia: [],
      messageText: "Задачи на сегодня: 4",
      telegramChatId: "101",
      telegramMessageId: "7501",
    }, "✅ Прочитано в 8:10");

    const [url, init] = telegramFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telegram.org/bottelegram-bot-secret/editMessageReplyMarkup");
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: "101",
      message_id: 7501,
      reply_markup: { inline_keyboard: [[{ text: "🌐 Меню", url: "https://example.com/menu" }], [{ disabled: {}, text: "✅ Прочитано в 8:10" }]] },
    });
  });
});
