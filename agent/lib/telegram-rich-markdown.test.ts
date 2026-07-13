/**
 * Safe Telegram Rich Markdown regression tests.
 *
 * Constructs covered:
 * - Supported text-rich Markdown and a narrow inline HTML allowlist survive sanitization.
 * - Model-authored media, Telegram service tags, and unsafe links are rendered inert.
 * - Final rich messages split only between complete blocks at Telegram's length limit.
 * - The permanent prompt teaches semantic rich formatting without exposing transport control.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  formatTelegramRichMessageDraft,
  formatTelegramRichMessages,
  sanitizeTelegramRichMarkdown,
} from "./telegram-rich-markdown.js";

const INSTRUCTIONS_PATH = new URL("../instructions.md", import.meta.url);

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

  it("rejects tables wider than Telegram Rich Message supports", () => {
    const row = `| ${Array.from({ length: 21 }, (_, index) => `C${index}`).join(" | ")} |`;

    expect(() => sanitizeTelegramRichMarkdown(row)).toThrow(
      "AGENT_TELEGRAM_RICH_TABLE_TOO_WIDE",
    );
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

  it("stops draft updates when the complete preview exceeds the rich limit", () => {
    expect(formatTelegramRichMessageDraft("слово ".repeat(6_000))).toBeNull();
  });

  it("keeps an incomplete streamed HTML block inert until the model closes it", () => {
    expect(formatTelegramRichMessageDraft("<details><summary>Пояснение")).toBe(
      "&lt;details&gt;&lt;summary&gt;Пояснение",
    );
  });

  it("fails explicitly when one indivisible block exceeds the rich limit", () => {
    expect(() => formatTelegramRichMessages("я".repeat(32_769))).toThrow(
      "AGENT_TELEGRAM_RICH_BLOCK_TOO_LONG",
    );
  });
});

describe("Telegram rich presentation instructions", () => {
  it("teaches the model when to use rich structure and reserves transport controls", async () => {
    const instructions = await readFile(INSTRUCTIONS_PATH, "utf8");

    expect(instructions).toContain("# Rich Telegram presentation");
    expect(instructions).toContain("таблицу для настоящего сравнения");
    expect(instructions).toContain("`<details><summary>`");
    expect(instructions).toContain("Не создавай media-блоки");
    expect(instructions).toContain("`<tg-thinking>` добавляет только Telegram adapter");
  });
});
