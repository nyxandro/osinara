/**
 * One private-chat burst as one model-facing message.
 *
 * Constructs covered:
 * - Only plain private messages join a burst: no voice, album, command, reply to the bot, message
 *   already shown to a running turn, or message without content that could start a turn.
 * - The followers of a head join in order until the first one that cannot, within the message,
 *   character and attachment limits; a head that cannot lead a burst takes none.
 * - The burst reads as one message: the head's identity, every part's text in order, and every
 *   part's files with their own Telegram message.
 */
import { describe, expect, it } from "vitest";

import {
  combineTelegramBurst,
  selectTelegramBurstMembers,
  type TelegramBurstCandidate,
} from "./telegram-private-burst-message.js";

const LIMITS = { maxCharacters: 6_000, maxMessages: 10 };
let nextId = 1000;

function message(fields: Record<string, unknown>): Record<string, unknown> {
  nextId += 1;
  return {
    message: {
      chat: { id: 101, type: "private" },
      date: 1_700_000_000,
      from: { first_name: "Анна", id: 101, is_bot: false },
      message_id: nextId,
      ...fields,
    },
    update_id: nextId,
  };
}

function candidate(payload: Record<string, unknown>, delivered = false): TelegramBurstCandidate {
  return { delivered, payload, updateId: String((payload.update_id as number)) };
}

const photo = { photo: [{ file_id: "photo-1", file_size: 100, file_unique_id: "u1", height: 10, width: 10 }] };

describe("selectTelegramBurstMembers", () => {
  it("joins the plain messages behind the head in order", () => {
    const head = candidate(message({ text: "вот такой ответ ты прислала" }));
    const second = candidate(message({ text: "мне не нравится" }));
    const third = candidate(message({ ...photo, caption: "как здесь" }));

    expect(selectTelegramBurstMembers(head, [second, third], LIMITS)).toEqual([second.updateId, third.updateId]);
  });

  it.each([
    ["a voice message", { voice: { duration: 2, file_id: "voice-1" } }],
    ["an album", { ...photo, media_group_id: "album-1" }],
    ["a command", { text: "/help" }],
    ["a reply to the bot", { reply_to_message: { chat: { id: 101, type: "private" }, date: 1, from: { first_name: "Osinara", id: 900, is_bot: true }, message_id: 1, text: "Подтвердить?" }, text: "да" }],
    ["a lone sticker", { sticker: { file_id: "sticker-1", file_unique_id: "s1", height: 1, is_animated: false, is_video: false, type: "regular", width: 1 } }],
  ])("stops at %s", (_label, fields) => {
    const head = candidate(message({ text: "смотри" }));
    const stop = candidate(message(fields));
    const after = candidate(message({ text: "и ещё" }));

    expect(selectTelegramBurstMembers(head, [stop, after], LIMITS)).toEqual([]);
  });

  it("stops at a message a running turn already saw, and a seen head leads nothing", () => {
    const head = candidate(message({ text: "первое" }));
    const seen = candidate(message({ text: "уже показано" }), true);
    expect(selectTelegramBurstMembers(head, [seen], LIMITS)).toEqual([]);

    expect(selectTelegramBurstMembers(candidate(message({ text: "показано" }), true), [candidate(message({ text: "дальше" }))], LIMITS))
      .toEqual([]);
  });

  it("takes no followers when the head itself cannot lead a burst", () => {
    const head = candidate(message({ voice: { duration: 2, file_id: "voice-1" } }));
    expect(selectTelegramBurstMembers(head, [candidate(message({ text: "текст" }))], LIMITS)).toEqual([]);
  });

  it("keeps the burst within its message and character limits", () => {
    const head = candidate(message({ text: "a".repeat(3_000) }));
    const fits = candidate(message({ text: "b".repeat(2_500) }));
    const overflows = candidate(message({ text: "c".repeat(1_000) }));
    expect(selectTelegramBurstMembers(head, [fits, overflows], LIMITS)).toEqual([fits.updateId]);

    // Markup is escaped for the model, so a text full of it takes far more than its raw length.
    const markup = candidate(message({ text: "<".repeat(900) }));
    expect(selectTelegramBurstMembers(candidate(message({ text: "<".repeat(900) })), [markup], LIMITS)).toEqual([]);

    const many = Array.from({ length: 12 }, () => candidate(message({ text: "да" })));
    expect(selectTelegramBurstMembers(candidate(message({ text: "раз" })), many, LIMITS)).toHaveLength(9);
  });
});

describe("combineTelegramBurst", () => {
  it("reads as one message from the head with every part in order", () => {
    const head = message({ text: "вот такой ответ ты прислала" });
    const withPhoto = message({ ...photo, caption: "как здесь" });
    const last = message({ text: "нужны только внятные обновления" });

    const update = combineTelegramBurst([head, withPhoto, last]);

    expect(update.kind).toBe("message");
    if (update.kind !== "message") return;
    expect(update.message.messageId).toBe(String((head.message as { message_id: number }).message_id));
    expect(update.message.text).toBe("вот такой ответ ты прислала\n\nкак здесь\n\nнужны только внятные обновления");
    expect(update.message.caption).toBe("");
    expect(update.message.attachments).toEqual([
      expect.objectContaining({ telegramMessageId: String((withPhoto.message as { message_id: number }).message_id) }),
    ]);
  });
});
