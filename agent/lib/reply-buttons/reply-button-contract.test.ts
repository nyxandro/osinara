/**
 * Reply button contract tests.
 *
 * Constructs covered:
 * - A label is one short line without markup characters, counted in characters.
 * - Only callback data a set of ours could have produced is read back.
 * - The settled caption names the presser in a group and drops markup from their name.
 */
import { describe, expect, it } from "vitest";

import {
  parseReplyButtonCallback,
  selectedReplyCaption,
  validateReplyButtonLabel,
} from "./reply-button-contract.js";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

describe("reply button label", () => {
  it("trims a label and counts its length in characters, so an emoji does not use up the limit", () => {
    expect(validateReplyButtonLabel(" ✅ Да, заказываем ")).toBe("✅ Да, заказываем");
    expect(validateReplyButtonLabel(`✅${"а".repeat(39)}`)).toBe(`✅${"а".repeat(39)}`);
  });

  it("keeps ordinary numbers, times and abbreviations", () => {
    for (const label of ["⏰ Через 15 минут", "К 19:00–19:30", "30 см", "т.е. да", "Версия 2.0", "📅 2026-10-26", "💰 1 000 000 ₽", "Node.js"]) {
      expect(validateReplyButtonLabel(label)).toBe(label);
    }
  });

  it.each([
    ["a blank text", "  ", "одна строка от 1 до 40"],
    ["a long text", "я".repeat(41), "одна строка от 1 до 40"],
    ["two lines", "Да\nНет", "одна строка от 1 до 40"],
    ["markup", "*Да*", "символов разметки"],
    ["a site", "Открыть ozon.ru", "ссылок"],
    ["a Cyrillic site", "Открыть сайт.рф", "ссылок"],
    ["a link", "https://example.com", "ссылок"],
    ["a mention", "Спросить @mama", "ссылок"],
    ["an e-mail", "a@b.ru", "ссылок"],
    ["a phone", "Позвонить +7 999 123-45-67", "ссылок"],
    ["a command", "/start", "ссылок"],
  ])("refuses %s with an actionable error", (_case, label, message) => {
    expect(() => validateReplyButtonLabel(label)).toThrow(expect.objectContaining({
      code: "AGENT_REPLY_BUTTONS_INVALID",
      message: expect.stringContaining(message),
    }));
  });
});

describe("reply button callback data", () => {
  it("reads back only data of the shape it writes", () => {
    expect(parseReplyButtonCallback(`rb:${TOKEN}:3`)).toEqual({ index: 3, token: TOKEN });
    expect(parseReplyButtonCallback(`rb:${TOKEN}:12`)).toBeNull();
    expect(parseReplyButtonCallback(`rb:${TOKEN.slice(1)}:0`)).toBeNull();
    expect(parseReplyButtonCallback(`hitl:${TOKEN}:0`)).toBeNull();
  });
});

describe("settled caption", () => {
  it("shows the choice alone in a private chat and with the presser in a group", () => {
    expect(selectedReplyCaption("✅ Да", null)).toBe("Выбрано: ✅ Да");
    expect(selectedReplyCaption("✅ Да", "Андрей")).toBe("Выбрано: ✅ Да (Андрей)");
  });

  it("keeps a name from restyling the message", () => {
    expect(selectedReplyCaption("✅ Да", "*Анна_К*")).toBe("Выбрано: ✅ Да (АннаК)");
    expect(selectedReplyCaption("✅ Да", "**")).toBe("Выбрано: ✅ Да");
  });
});
