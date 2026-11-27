/**
 * Inbound Telegram rich message flattening tests.
 *
 * Constructs covered:
 * - Nested rich text collapses to the plain text a person actually reads.
 * - Every container block contributes its text: lists, tables, details, media captions.
 * - Structural noise (block types, ids, urls) never leaks into the flattened text.
 * - A rich message without any readable text is reported as absent, not as an empty string.
 * - A fragment highlighted in a rich message joins its quotable texts with line feeds.
 */
import { describe, expect, it } from "vitest";

import { telegramRichMessageText, telegramRichQuoteText } from "./telegram-rich-inbound.js";

describe("telegramRichMessageText", () => {
  it("flattens nested rich text of a paragraph", () => {
    expect(telegramRichMessageText({
      blocks: [{
        text: [
          "Привет, ",
          { text: { text: "Осинара", type: "bold" }, type: "italic" },
          "!",
        ],
        type: "paragraph",
      }],
    })).toBe("Привет, Осинара!");
  });

  it("keeps a mention readable so addressing still works", () => {
    expect(telegramRichMessageText({
      blocks: [{
        text: [{ text: "@osinara_bot", type: "mention" }, " как дела?"],
        type: "paragraph",
      }],
    })).toBe("@osinara_bot как дела?");
  });

  it("separates blocks by a blank line and drops dividers", () => {
    expect(telegramRichMessageText({
      blocks: [
        { text: "Итоги", type: "section_heading" },
        { type: "divider" },
        { text: "Всё готово.", type: "paragraph" },
      ],
    })).toBe("Итоги\n\nВсё готово.");
  });

  it("renders list items with their labels", () => {
    expect(telegramRichMessageText({
      blocks: [{
        items: [
          { blocks: [{ text: "первый", type: "paragraph" }], label: "1." },
          { blocks: [{ text: "второй", type: "paragraph" }], label: "2." },
        ],
        type: "list",
      }],
    })).toBe("1. первый\n2. второй");
  });

  it("keeps both the summary and the hidden content of a details block", () => {
    expect(telegramRichMessageText({
      blocks: [{
        blocks: [{ text: "Спрятанные подробности", type: "paragraph" }],
        summary: "Подробности",
        type: "details",
      }],
    })).toBe("Подробности\n\nСпрятанные подробности");
  });

  it("renders a table row by row", () => {
    expect(telegramRichMessageText({
      blocks: [{
        cells: [
          [{ text: "Ключ" }, { text: "Значение" }],
          [{ text: "срок" }, { text: "пятница" }],
        ],
        type: "table",
      }],
    })).toBe("Ключ | Значение\nсрок | пятница");
  });

  it("keeps a media caption and its credit", () => {
    expect(telegramRichMessageText({
      blocks: [{
        caption: { credit: "Мия", text: "Схема разговора" },
        photo: [{ file_id: "photo-1", file_unique_id: "u1", height: 10, width: 10 }],
        type: "photo",
      }],
    })).toBe("Схема разговора\nМия");
  });

  it("never leaks structural values into the text", () => {
    const flattened = telegramRichMessageText({
      blocks: [{
        text: [
          { text: "ссылка", type: "url", url: "https://example.com/secret" },
          { emoji_id: "5535034915403333642", text: "🔥", type: "custom_emoji" },
        ],
        type: "paragraph",
      }],
    });

    expect(flattened).toBe("ссылка🔥");
    expect(flattened).not.toContain("example.com");
    expect(flattened).not.toContain("paragraph");
  });

  it.each([
    { label: "not an object", value: "просто строка" },
    { label: "missing blocks", value: {} },
    { label: "blocks of the wrong shape", value: { blocks: "нет" } },
    { label: "text-free media only", value: { blocks: [{ type: "photo" }] } },
    { label: "blank text", value: { blocks: [{ text: "   ", type: "paragraph" }] } },
  ])("reports no text for $label", ({ value }) => {
    expect(telegramRichMessageText(value)).toBeNull();
  });
});

describe("telegramRichQuoteText", () => {
  it("joins the quotable texts of a fragment with line feeds and keeps nested formatting as text", () => {
    expect(telegramRichQuoteText([
      "Итоги",
      ["Готово ", { text: { text: "сегодня", type: "italic" }, type: "bold" }],
      "  ",
    ])).toBe("Итоги\nГотово сегодня");
  });

  // These two carry their text in their own fields, not in `text`.
  it("keeps a formula and a custom emoji readable", () => {
    expect(telegramRichQuoteText([
      ["Формула ", { expression: "E=mc^2", type: "mathematical_expression" }],
      [{ alternative_text: "🔥", custom_emoji_id: "5368324170671202286", type: "custom_emoji" }, " горячо"],
    ])).toBe("Формула E=mc^2\n🔥 горячо");
  });

  it.each([
    { label: "absent", value: undefined },
    { label: "not an array", value: "строка" },
    { label: "only blank texts", value: ["", "  "] },
  ])("reports no fragment when it is $label", ({ value }) => {
    expect(telegramRichQuoteText(value)).toBeNull();
  });
});
