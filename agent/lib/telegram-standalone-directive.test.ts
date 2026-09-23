/**
 * Standalone Telegram message directive tests.
 *
 * Constructs covered:
 * - `readTelegramStandaloneDirective`: the model's request to send a group answer without a reply.
 * - The directive never reaches a person, on its own line or inside text.
 * - Directives inside fenced or indented code stay literal content of the answer.
 * - Other transport directives are left for their own readers.
 */
import { describe, expect, it } from "vitest";

import {
  readTelegramStandaloneDirective,
  TELEGRAM_STANDALONE_DIRECTIVE,
} from "./telegram-standalone-directive.js";

const directive = TELEGRAM_STANDALONE_DIRECTIVE;

describe("readTelegramStandaloneDirective", () => {
  it("keeps an ordinary answer as a reply to the triggering message", () => {
    expect(readTelegramStandaloneDirective("Код домофона 4271.")).toEqual({
      markdown: "Код домофона 4271.",
      standalone: false,
    });
  });

  it("marks an answer opened by the directive line as a standalone message", () => {
    const markdown = `${directive}\nСоседи, у нас на 4 этаже опять затопило с потолка.`;

    expect(readTelegramStandaloneDirective(markdown)).toEqual({
      markdown: "Соседи, у нас на 4 этаже опять затопило с потолка.",
      standalone: true,
    });
  });

  it("accepts the directive line anywhere outside code, with trailing whitespace or CRLF", () => {
    expect(readTelegramStandaloneDirective(`Объявление\r\n${directive}  \r\nвторая строка`))
      .toEqual({ markdown: "Объявление\r\nвторая строка", standalone: true });
  });

  it("does not widen the gap between paragraphs where the directive line stood", () => {
    expect(readTelegramStandaloneDirective(`Первый абзац\n\n${directive}\n\nВторой абзац`))
      .toEqual({ markdown: "Первый абзац\n\nВторой абзац", standalone: true });
  });

  it("removes a directive written inside text instead of showing it to a person", () => {
    expect(readTelegramStandaloneDirective(`Готово ${directive} текст для соседей`)).toEqual({
      markdown: "Готово текст для соседей",
      standalone: true,
    });
  });

  it("leaves the aside directive for the presentation layer", () => {
    expect(readTelegramStandaloneDirective(`${directive}\nОбъявление\n[[split]]\nкстати`))
      .toEqual({ markdown: "Объявление\n[[split]]\nкстати", standalone: true });
  });

  it("keeps a directive inside a fenced code block literal", () => {
    const markdown = `Пример:\n\`\`\`\n${directive}\n\`\`\``;

    expect(readTelegramStandaloneDirective(markdown)).toEqual({ markdown, standalone: false });
  });

  it("keeps blank lines inside a code block of a standalone answer", () => {
    const code = "```\nа\n\n\n\nб\n```";

    expect(readTelegramStandaloneDirective(`${directive}\n${code}`))
      .toEqual({ markdown: code, standalone: true });
  });

  it("keeps a directive on an indented code line literal", () => {
    const markdown = `Пример:\n\n    ${directive}`;

    expect(readTelegramStandaloneDirective(markdown)).toEqual({ markdown, standalone: false });
  });

  it("reduces an answer made of the directive alone to empty text", () => {
    expect(readTelegramStandaloneDirective(`  ${directive}  `)).toEqual({
      markdown: "",
      standalone: true,
    });
  });
});
