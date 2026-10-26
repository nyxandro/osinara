/**
 * Safe Telegram Rich Markdown regression tests.
 *
 * Constructs covered:
 * - Supported text-rich Markdown and a narrow inline HTML allowlist survive sanitization.
 * - Tolerated spellings of the collapsible block are canonicalized instead of escaped.
 * - A truncated collapsible block is closed; other malformed allowed HTML is rendered inert.
 * - Model-authored media, Telegram service tags, and unsafe links are rendered inert.
 * - Final rich messages split only between complete blocks at Telegram's length limit.
 */
import { describe, expect, it } from "vitest";

import {
  formatTelegramRichMessages,
  sanitizeTelegramRichMarkdown,
} from "./telegram-rich-markdown.js";

describe("sanitizeTelegramRichMarkdown", () => {
  it("keeps useful rich structure and only explicitly allowed HTML", () => {
    const markdown = [
      "## Сравнение",
      "",
      "| Вариант | Риск |",
      "| --- | --- |",
      "| A | Низкий |",
      "",
      "<details open><summary>Обоснование</summary>",
      "",
      "Формула $x^2$ и <u>важный текст</u>.",
      "",
      "</details>",
    ].join("\n");

    expect(sanitizeTelegramRichMarkdown(markdown)).toBe(markdown);
  });

  it("neutralizes raw media, service tags, scripts, and unsafe inline links", () => {
    const sanitized = sanitizeTelegramRichMarkdown([
      "![чужое изображение](https://tracker.example/image.png)",
      '<img src="https://tracker.example/image.png"/>',
      "<tg-thinking>Подмена</tg-thinking>",
      "<script>alert(1)</script>",
      "[опасная ссылка](javascript:alert(1))",
    ].join("\n"));

    expect(sanitized).toContain("\\![чужое изображение]");
    expect(sanitized).toContain("&lt;img src=");
    expect(sanitized).toContain("&lt;tg-thinking&gt;");
    expect(sanitized).toContain("&lt;script&gt;");
    expect(sanitized).toContain("опасная ссылка (javascript:alert(1))");
    expect(sanitized).not.toContain('<img src="');
    expect(sanitized).not.toContain("<tg-thinking>");
  });

  it("neutralizes unsafe links with nested parentheses", () => {
    const sanitized = sanitizeTelegramRichMarkdown([
      "[javascript](javascript:alert((1)))",
      "[telegram](tg://resolve?domain=a(b(c)))",
      "[safe](https://example.com/a(b(c)))",
    ].join("\n"));

    expect(sanitized).toContain("javascript (javascript:alert((1)))");
    expect(sanitized).toContain("telegram (tg://resolve?domain=a(b(c)))");
    expect(sanitized).toContain("[safe](https://example.com/a(b(c)))");
    expect(sanitized).not.toContain("[javascript](javascript:");
    expect(sanitized).not.toContain("[telegram](tg:");
  });

  it("ignores allowed-looking HTML inside inline and fenced code", () => {
    const markdown = [
      "`<details>` остаётся примером.",
      "",
      "```html",
      "<details><summary>Пример</summary>",
      "```",
    ].join("\n");

    expect(sanitizeTelegramRichMarkdown(markdown)).toBe(markdown);
  });

  it.each([
    ["an indented line after a paragraph", "Смотрите:\n    <tg-button type=\"web_app\" url=\"https://evil.example\">Открыть</tg-button>"],
    ["an escaped backtick", "Смотрите: \\`<tg-button type=\"url\" url=\"tg://resolve?domain=x\">Открыть</tg-button>\\`"],
    ["an unclosed fence", "Смотрите:\n```\n<tg-button-row><tg-button type=\"copy_text\" text=\"x\">Копировать</tg-button></tg-button-row>"],
  ])("never lets a Telegram tag through %s, where it would be live", (_case, markdown) => {
    const sanitized = sanitizeTelegramRichMarkdown(markdown);

    expect(sanitized).not.toMatch(/<\/?tg-/u);
    // The reader still sees the same characters: the break is an invisible zero-width space.
    expect(sanitized.replaceAll("\u200B", "")).toContain("tg-button");
  });

  it("rejects tables wider than Telegram Rich Message supports", () => {
    const row = `| ${Array.from({ length: 21 }, (_, index) => `C${index}`).join(" | ")} |`;

    expect(() => sanitizeTelegramRichMarkdown(row)).toThrow(
      "AGENT_TELEGRAM_RICH_TABLE_TOO_WIDE",
    );
  });

  it("rejects an outerless GFM table wider than Telegram Rich Message supports", () => {
    const columns = Array.from({ length: 21 }, (_, index) => `C${index + 1}`);
    const delimiters = columns.map(() => "---");

    expect(() => sanitizeTelegramRichMarkdown(
      `${columns.join(" | ")}\n${delimiters.join(" | ")}\n${columns.join(" | ")}`,
    )).toThrowError("AGENT_TELEGRAM_RICH_TABLE_TOO_WIDE");
  });

  it("canonicalizes tolerated spellings of the collapsible block", () => {
    const sanitized = sanitizeTelegramRichMarkdown(
      ['<details open="true"><summary >Итог</summary>', "", "Текст", "", "</DETAILS>"].join("\n"),
    );

    expect(sanitized).toBe(
      ["<details open><summary>Итог</summary>", "", "Текст", "", "</details>"].join("\n"),
    );
  });

  it("renders a collapsible block with an unsupported attribute inert", () => {
    const sanitized = sanitizeTelegramRichMarkdown(
      '<details class="wide"><summary>Итог</summary>Текст</details>',
    );

    expect(sanitized).toContain('&lt;details class="wide"&gt;');
    expect(sanitized).toContain("&lt;/details&gt;");
  });

  it("closes a truncated collapsible block instead of escaping the whole answer", () => {
    expect(
      formatTelegramRichMessages(
        "<details><summary>Результат</summary>\n\nОтвет без закрывающего details",
      ),
    ).toEqual([
      "<details><summary>Результат</summary>\n\nОтвет без закрывающего details\n\n</details>",
    ]);
  });

  it("neutralizes other unclosed allowed HTML instead of blocking final delivery", () => {
    expect(
      formatTelegramRichMessages("<details><summary>Результат\n\nОтвет без закрытия summary"),
    ).toEqual([
      "&lt;details&gt;&lt;summary&gt;Результат\n\nОтвет без закрытия summary",
    ]);
  });
});

describe("formatTelegramRichMessages", () => {
  it("splits oversized output only between complete Markdown blocks", () => {
    const paragraph = "слово ".repeat(3_000).trim();
    const chunks = formatTelegramRichMessages(`${paragraph}\n\n${paragraph}`);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 32_768)).toBe(true);
    expect(chunks).toEqual([paragraph, paragraph]);
  });

  it("does not split a fenced code block at its internal blank lines", () => {
    const paragraph = "я".repeat(30_000);
    const code = `\`\`\`text\n${"a".repeat(2_000)}\n\n${"b".repeat(2_000)}\n\`\`\``;
    const chunks = formatTelegramRichMessages(`${paragraph}\n\n${code}`);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(paragraph);
    expect(chunks[1]).toBe(code);
  });

  it("fails explicitly when one indivisible block exceeds the rich limit", () => {
    expect(() => formatTelegramRichMessages("я".repeat(32_769))).toThrow(
      "AGENT_TELEGRAM_RICH_BLOCK_TOO_LONG",
    );
  });

  it("splits an oversized details block into independently balanced messages", () => {
    const tail = "КОНЕЦ_ДЛИННОГО_ОТВЕТА";
    const body = `${"Большой раздел данных. ".repeat(3_500)}${tail}`;
    const chunks = formatTelegramRichMessages(
      `<details><summary>Подробный разбор</summary>\n\n${body}\n\n</details>`,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 32_768)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("<details><summary>"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("</details>"))).toBe(true);
    expect(chunks.at(-1)).toContain(tail);
  });

  it("keeps every rich chunk below the provider block-count limit", () => {
    const body = Array.from({ length: 501 }, (_, index) => `- пункт ${index + 1}`).join("\n");
    const chunks = formatTelegramRichMessages(
      `<details><summary>Большой список</summary>\n\n${body}\n\n</details>`,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith("<details><summary>"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("</details>"))).toBe(true);
    expect(chunks.every((chunk) => (chunk.match(/^- /gmu)?.length ?? 0) <= 498)).toBe(true);
  });
});
