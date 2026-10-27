/**
 * Line breaks of model text in a Telegram rich message.
 *
 * Constructs covered:
 * - A line break inside a paragraph, a quote or a list item becomes a hard break, so the person sees
 *   the lines the model wrote instead of one run-on line.
 * - Fenced code, block formulas, table rows, headings, HTML blocks, blank lines and existing hard
 *   breaks are left exactly as written, and a plain list stays as written.
 * - Properties: the result is the input plus trailing spaces only, applying it twice changes
 *   nothing, and a fenced block is never touched.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { keepTelegramRichLineBreaks } from "./telegram-rich-line-breaks.js";

describe("keeping line breaks of a rich message", () => {
  it("keeps the lines of a paragraph apart", () => {
    expect(keepTelegramRichLineBreaks("**Итог по покупкам:**\nМолоко — 100 ₽\nХлеб — 50 ₽\n\nВсё верно?"))
      .toBe("**Итог по покупкам:**  \nМолоко — 100 ₽  \nХлеб — 50 ₽\n\nВсё верно?");
  });

  it("keeps the lines of a quote and a list item's continuation apart", () => {
    expect(keepTelegramRichLineBreaks("> первая строка\n> вторая строка")).toBe("> первая строка  \n> вторая строка");
    expect(keepTelegramRichLineBreaks("- пункт\n  его продолжение")).toBe("- пункт  \n  его продолжение");
  });

  it("keeps a numbered line that cannot start a list from joining the line above", () => {
    expect(keepTelegramRichLineBreaks("Шаги:\n2. второй")).toBe("Шаги:  \n2. второй");
  });

  it("leaves a plain list, a table, a heading and a formula as written", () => {
    const markdown = [
      "## Итог",
      "Вступление",
      "",
      "- первый",
      "- второй",
      "",
      "| Что | Цена |",
      "|---|---:|",
      "| Молоко | 100 |",
      "",
      "$$",
      "a^2 + b^2",
      "= c^2",
      "$$",
    ].join("\n");

    expect(keepTelegramRichLineBreaks(markdown)).toBe(markdown);
  });

  it("leaves fenced code and lines that already break as written", () => {
    const markdown = "Код:\n```ts\nconst a = 1;\nconst b = 2;\n```\nУже с переносом  \nи с чертой\\\nконец";

    expect(keepTelegramRichLineBreaks(markdown))
      .toBe("Код:\n```ts\nconst a = 1;\nconst b = 2;\n```\nУже с переносом  \nи с чертой\\\nконец");
  });

  it("leaves the lines of a collapsible block's frame as written", () => {
    const markdown = "Вывод\n<details><summary>Лог</summary>\nстрока 1\nстрока 2\n</details>";
    // Without a blank line the frame and its lines are one HTML block, which Markdown shows as is.
    expect(keepTelegramRichLineBreaks(markdown)).toBe(markdown);
  });

  it("reads Windows line endings as line breaks", () => {
    expect(keepTelegramRichLineBreaks("Итог:\r\nМолоко\r\n")).toBe("Итог:  \nМолоко\n");
  });

  it("leaves a line break inside a code span as written", () => {
    expect(keepTelegramRichLineBreaks("Команда `ls\n-la` и\nдальше")).toBe("Команда `ls\n-la` и  \nдальше");
  });

  it("keeps the inside of an unclosed fence as written", () => {
    const markdown = "Код:\n```\nстрока 1\nстрока 2";
    expect(keepTelegramRichLineBreaks(markdown)).toBe(markdown);
  });
});

// Lines a model writes: prose, list items, quotes, headings, table rows, fences and blank lines.
const LINE = fc.oneof(
  fc.constantFrom("Итог:", "Молоко — 100 ₽", "просто строка", "", "", "- пункт", "1. первый", "2. второй",
    "> цитата", "## Заголовок", "| a | b |", "|---|---|", "```", "```ts", "const a = 1;", "$$", "x^2", "    отступ"),
  fc.string({ maxLength: 12 }).map((text) => text.replace(/\n/gu, " ")),
);
const MARKDOWN = fc.array(LINE, { maxLength: 25 }).map((lines) => lines.join("\n"));

describe("line break properties", () => {
  it("only adds trailing spaces, is stable when applied again, and never touches a fenced block", () => {
    fc.assert(fc.property(MARKDOWN, (markdown) => {
      const kept = keepTelegramRichLineBreaks(markdown);
      const before = markdown.split("\n");
      const after = kept.split("\n");

      expect(after).toHaveLength(before.length);
      for (const [index, line] of after.entries()) {
        expect([before[index], `${before[index]}  `]).toContain(line);
      }
      expect(keepTelegramRichLineBreaks(kept)).toBe(kept);
      for (const block of markdown.matchAll(/^```[^\n]*\n[\s\S]*?^```$/gmu)) {
        expect(kept).toContain(block[0]);
      }
    }), {
      examples: [["Итог:\nстрока"], ["```\nа\nб\n```"], [""]],
    });
  });
});
