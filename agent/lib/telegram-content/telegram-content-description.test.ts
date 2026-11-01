/**
 * What the model reads for a Telegram message that is not plain text.
 *
 * Constructs covered:
 * - `telegramContentDescription`: one line for each kind of content — a place, a point, a contact, a
 *   poll, a die, a checklist, a sticker, a GIF, a video, a video note, a voice note, audio, a story
 *   and the rare kinds — with what Telegram sent and never a file identifier.
 * - `telegramMessageContextNote`: who a message was forwarded from, a reply to another chat or to a story.
 * - `telegramMessageDisplay`: a forward's content is quoted; other notes and the sender's words are not.
 * - `isTelegramMediaPlaceholderOnly`: a message that is only a media placeholder carries no words.
 * - Property: every valid content message is described in full, on one line, without a file identifier.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  isTelegramMediaPlaceholderOnly,
  telegramContentDescription,
  telegramMessageContextNote,
  telegramMessageDisplay,
} from "./telegram-content-description.js";

// The message from production, 31.10.2026: the agent answered that an empty message had arrived.
const VENUE_31_10 = {
  location: { latitude: 52.424577, longitude: 37.608176 },
  venue: {
    address: "Ленина Ул., д. 12",
    foursquare_id: "50702758e4b06190ff848dc2",
    foursquare_type: "food/coffeeshop",
    location: { latitude: 52.424577, longitude: 37.608176 },
    title: "Чашка",
  },
};

describe("telegramContentDescription", () => {
  it.each([
    ["a place", VENUE_31_10, "📍 Место «Чашка», Ленина Ул., д. 12 (food/coffeeshop) — 52.424577, 37.608176"],
    ["a point", { location: { horizontal_accuracy: 20, latitude: 55.75, longitude: 37.61 } }, "📍 Геопозиция 55.75, 37.61, точность ±20 м"],
    ["a live point", { location: { latitude: 55.75, live_period: 900, longitude: 37.61 } }, "📍 Геопозиция 55.75, 37.61, трансляция на 15 мин"],
    ["a contact", { contact: { first_name: "Иван", last_name: "Петров", phone_number: "+79001234567", user_id: 42 } }, "👤 Контакт: Иван Петров, +79001234567"],
    ["a poll", {
      poll: {
        allows_multiple_answers: true, id: "p1", is_anonymous: true, is_closed: false,
        options: [{ text: "кино", voter_count: 0 }, { text: "театр", voter_count: 0 }, { text: "дома", voter_count: 0 }],
        question: "Куда идём в субботу?", total_voter_count: 0, type: "regular",
      },
    }, "📊 Опрос «Куда идём в субботу?»: кино / театр / дома (анонимный, можно несколько)"],
    ["a closed quiz with votes", {
      poll: {
        allows_multiple_answers: false, id: "p2", is_anonymous: false, is_closed: true,
        options: [{ text: "4", voter_count: 3 }, { text: "5", voter_count: 1 }],
        question: "2+2?", total_voter_count: 4, type: "quiz",
      },
    }, "📊 Опрос «2+2?»: 4 — 3 / 5 — 1 (открытый, викторина, закрыт)"],
    ["a die", { dice: { emoji: "🎲", value: 4 } }, "🎲 Кубик: выпало 4"],
    ["a dart", { dice: { emoji: "🎯", value: 6 } }, "🎯 Бросок: 6"],
    ["a checklist", {
      checklist: { tasks: [{ completion_date: 1_793_000_000, id: 1, text: "хлеб" }, { id: 2, text: "молоко" }], title: "Покупки" },
    }, "☑️ Список «Покупки»: ✓ хлеб / молоко"],
    ["a sticker", { sticker: { emoji: "😂", file_id: "f", file_unique_id: "u", height: 512, set_name: "Cats", width: 512 } }, "[стикер 😂 из набора «Cats»]"],
    ["a bare sticker", { sticker: { file_id: "f", file_unique_id: "u", height: 512, width: 512 } }, "[стикер]"],
    ["a GIF", { animation: { duration: 3, file_id: "f", file_unique_id: "u", height: 1, width: 1 } }, "[GIF 0:03]"],
    ["a video", { video: { duration: 75, file_id: "f", file_unique_id: "u", height: 1, width: 1 } }, "[видео 1:15]"],
    ["a video note", { video_note: { duration: 20, file_id: "f", file_unique_id: "u", length: 240 } }, "[видеосообщение 0:20]"],
    ["a voice note", { voice: { duration: 42, file_id: "f", file_unique_id: "u" } }, "[голосовое 0:42]"],
    ["a song", { audio: { duration: 200, file_id: "f", file_unique_id: "u", performer: "Кино", title: "Группа крови" } }, "[аудио: Кино — Группа крови, 3:20]"],
    ["an audio file", { audio: { duration: 3_725, file_id: "f", file_name: "lecture.mp3", file_unique_id: "u" } }, "[аудио «lecture.mp3», 1:02:05]"],
    ["a story", { story: { chat: { id: 1, title: "Канал", type: "channel" }, id: 7 } }, "[история от «Канал»]"],
    ["paid media", { paid_media: { paid_media: [], star_count: 5 } }, "[платное медиа]"],
    ["a game", { game: { description: "", photo: [], title: "Змейка" } }, "[игра «Змейка»]"],
    ["a gift", { gift: { gift: { id: "g" } } }, "[подарок]"],
    ["a giveaway", { giveaway: { chats: [], prize_star_count: 10, winner_count: 1, winners_selection_date: 0 } }, "[розыгрыш]"],
    ["an invoice", { invoice: { currency: "RUB", description: "", start_parameter: "", title: "Заказ", total_amount: 100 } }, "[счёт «Заказ»]"],
  ])("describes %s", (_name, raw, expected) => {
    expect(telegramContentDescription(raw)).toBe(expected);
  });

  it("says nothing for plain text, a photo or a document: they reach the model by their own route", () => {
    expect(telegramContentDescription({ text: "привет" })).toBeNull();
    expect(telegramContentDescription({ photo: [{ file_id: "f", file_unique_id: "u", height: 1, width: 1 }] })).toBeNull();
    expect(telegramContentDescription({ document: { file_id: "f", file_unique_id: "u" } })).toBeNull();
  });

  it("keeps one line and a bounded length whatever a participant typed into a title", () => {
    const description = telegramContentDescription({
      venue: { address: "улица\nс переносом", location: { latitude: 1, longitude: 2 }, title: "x".repeat(500) },
    })!;

    expect(description).not.toContain("\n");
    expect(description).toContain("улица с переносом");
    expect(description.length).toBeLessThan(300);
  });

  it("describes every valid content message in full, on one line, without a file identifier", () => {
    // Participants type these fields: any text, emoji and surrogate pairs included, short enough
    // to stay under the length bound.
    const typed = fc.string({ maxLength: 60, minLength: 1, unit: "grapheme" })
      .map((value) => value.replace(/\s+/gu, " ").trim())
      // A grapheme can span several code units; past 120 the bound below shortens a field on purpose.
      .filter((value) => value.length > 0 && value.length <= 120);
    const fileId = fc.string({ maxLength: 40, minLength: 20, unit: "binary-ascii" }).map((value) => `FILE-${value}`);
    const content = fc.oneof(
      fc.record({ address: typed, title: typed }).map(({ address, title }) => ({
        fields: [title, address], raw: { venue: { address, location: { latitude: 1.5, longitude: 2.5 }, title } },
      })),
      fc.record({ first: typed, phone: typed }).map(({ first, phone }) => ({
        fields: [first, phone], raw: { contact: { first_name: first, phone_number: phone } },
      })),
      fc.record({ options: fc.uniqueArray(typed, { maxLength: 6, minLength: 2 }), question: typed }).map(({ options, question }) => ({
        fields: [question, ...options],
        raw: { poll: { id: "p", is_anonymous: true, options: options.map((text) => ({ text, voter_count: 0 })), question, total_voter_count: 0, type: "regular" } },
      })),
      fc.record({ emoji: typed, id: fileId, set: typed }).map(({ emoji, id, set }) => ({
        fields: [emoji, set], raw: { sticker: { emoji, file_id: id, file_unique_id: id, set_name: set } },
      })),
      fc.record({ id: fileId, performer: typed, title: typed }).map(({ id, performer, title }) => ({
        fields: [performer, title], raw: { audio: { duration: 61, file_id: id, file_unique_id: id, performer, title } },
      })),
    );

    fc.assert(fc.property(content, ({ fields, raw }) => {
      const description = telegramContentDescription(raw);
      expect(description).not.toBeNull();
      expect(description).not.toMatch(/[\n\r]/u);
      for (const field of fields) expect(description).toContain(field);
      expect(description).not.toContain("FILE-");
    }), {
      examples: [[{ fields: ["Чашка", "Ленина Ул., д. 12"], raw: VENUE_31_10 }]],
    });
  });
});

describe("telegramMessageContextNote", () => {
  it.each([
    ["a person", { forward_origin: { date: 1_793_000_000, sender_user: { first_name: "Иван", id: 1, is_bot: false, last_name: "Петров", username: "ivan" }, type: "user" } },
      "↪ Переслано от Иван Петров (@ivan), 2026-10-26"],
    ["a hidden person", { forward_origin: { date: 1_793_000_000, sender_user_name: "Скрытый", type: "hidden_user" } },
      "↪ Переслано от Скрытый, 2026-10-26"],
    ["a group", { forward_origin: { author_signature: "Анна", date: 1_793_000_000, sender_chat: { id: 1, title: "Чат", type: "supergroup" }, type: "chat" } },
      "↪ Переслано из «Чат», автор Анна, 2026-10-26"],
    ["a channel", { forward_origin: { chat: { id: 1, title: "Новости", type: "channel" }, date: 1_793_000_000, message_id: 5, type: "channel" } },
      "↪ Переслано из канала «Новости», 2026-10-26"],
    ["a reply to another chat", { external_reply: { chat: { id: 1, title: "Соседний чат", type: "supergroup" }, origin: { date: 1, sender_user_name: "x", type: "hidden_user" } } },
      "↩ Ответ на сообщение из «Соседний чат»"],
    ["a reply to a story", { reply_to_story: { chat: { id: 1, type: "private" }, id: 3 } }, "↩ Ответ на историю"],
  ])("names %s", (_name, raw, expected) => {
    expect(telegramMessageContextNote(raw)).toBe(expected);
  });

  it("says nothing for an ordinary message", () => {
    expect(telegramMessageContextNote({ text: "привет" })).toBeNull();
  });
});

describe("telegramMessageDisplay", () => {
  const forward = { date: 1_793_000_000, sender_user: { first_name: "Иван", id: 1, is_bot: false }, type: "user" };

  it("quotes every line a forward carries, so words written after it stay the sender's", () => {
    expect(telegramMessageDisplay({ forward_origin: forward }, "Встреча в пятницу\nв 15:00"))
      .toBe("↪ Переслано от Иван, 2026-10-26\n> Встреча в пятницу\n> в 15:00");
    expect(telegramMessageDisplay({ forward_origin: forward, ...VENUE_31_10 }, null))
      .toBe("↪ Переслано от Иван, 2026-10-26\n> 📍 Место «Чашка», Ленина Ул., д. 12 (food/coffeeshop) — 52.424577, 37.608176");
  });

  it("leaves the sender's own words of a reply to another chat unquoted", () => {
    expect(telegramMessageDisplay({ reply_to_story: { chat: { id: 1, type: "private" }, id: 3 } }, "класс"))
      .toBe("↩ Ответ на историю\nкласс");
    expect(telegramMessageDisplay({ sticker: { emoji: "😂" } }, null)).toBe("[стикер 😂]");
    expect(telegramMessageDisplay({}, "привет")).toBe("привет");
  });
});

describe("isTelegramMediaPlaceholderOnly", () => {
  it("recognises a message made only of media placeholders", () => {
    expect(isTelegramMediaPlaceholderOnly("[стикер 😂 из набора «Cats»]")).toBe(true);
    expect(isTelegramMediaPlaceholderOnly("[GIF 0:03]")).toBe(true);
    expect(isTelegramMediaPlaceholderOnly("[видео 0:15]\nсмотри что нашёл")).toBe(false);
    expect(isTelegramMediaPlaceholderOnly("📍 Место «Чашка», Ленина Ул., д. 12 — 52.4, 37.6")).toBe(false);
    expect(isTelegramMediaPlaceholderOnly("[ссылка] на сайт")).toBe(false);
  });
});
