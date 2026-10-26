/**
 * Reply button contract tests.
 *
 * Constructs covered:
 * - The model's rows are validated with errors the model can act on: count, row width, length,
 *   one line, no markup characters, no repeated answers.
 * - The keyboard carries only the set's token and a button index, and Telegram's own style names.
 * - Only callback data a set of ours could have produced is read back.
 * - The settled caption names the presser in a group and drops markup from their name.
 */
import { describe, expect, it } from "vitest";

import {
  parseReplyButtonCallback,
  parseReplyButtonRows,
  replyButtonKeyboard,
  replyButtonLabels,
  selectedReplyCaption,
} from "./reply-button-contract.js";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

describe("reply button rows", () => {
  it("keeps rows, colors and trimmed texts in order", () => {
    const rows = parseReplyButtonRows([
      [{ color: "green", text: " ✅ Да, заказываем " }, { color: "red", text: "❌ Отмена" }],
      [{ text: "✏️ Изменить заказ" }],
    ]);

    expect(rows).toEqual([
      [{ color: "green", text: "✅ Да, заказываем" }, { color: "red", text: "❌ Отмена" }],
      [{ text: "✏️ Изменить заказ" }],
    ]);
    expect(replyButtonLabels(rows)).toEqual(["✅ Да, заказываем", "❌ Отмена", "✏️ Изменить заказ"]);
  });

  it.each([
    ["no buttons", [], "от 1 до 6 кнопок"],
    ["an empty row", [[]], "от 1 до 6 кнопок"],
    ["seven buttons", [[{ text: "1" }, { text: "2" }, { text: "3" }], [{ text: "4" }, { text: "5" }, { text: "6" }], [{ text: "7" }]], "от 1 до 6 кнопок"],
    ["four in a row", [[{ text: "1" }, { text: "2" }, { text: "3" }, { text: "4" }]], "В каждом ряду от 1 до 3"],
    ["a blank text", [[{ text: "  " }]], "одна строка от 1 до 40"],
    ["a long text", [[{ text: "я".repeat(41) }]], "одна строка от 1 до 40"],
    ["two lines", [[{ text: "Да\nНет" }]], "одна строка от 1 до 40"],
    ["markup", [[{ text: "*Да*" }]], "символов разметки"],
    ["a repeated answer", [[{ text: "Да" }, { text: "да" }]], "не должны повторяться"],
    ["an unknown color", [[{ color: "yellow", text: "Да" }]], "rows: массив рядов"],
    ["a stray field", [[{ text: "Да", url: "https://example.com" }]], "rows: массив рядов"],
  ])("refuses %s with an actionable error", (_case, rows, message) => {
    expect(() => parseReplyButtonRows(rows)).toThrow(expect.objectContaining({
      code: "AGENT_REPLY_BUTTONS_INPUT_INVALID",
      message: expect.stringContaining(message),
    }));
  });

  it("counts a text's length in characters, so an emoji does not use up the limit", () => {
    expect(() => parseReplyButtonRows([[{ text: `✅${"а".repeat(39)}` }]])).not.toThrow();
  });
});

describe("reply button keyboard", () => {
  it("numbers the buttons across rows and maps colors to Telegram styles", () => {
    const keyboard = replyButtonKeyboard(TOKEN, [
      [{ color: "green", text: "Да" }, { color: "red", text: "Нет" }],
      [{ color: "blue", text: "Позже" }, { text: "Другое" }],
    ]);

    expect(keyboard).toEqual({ inline_keyboard: [
      [
        { callback_data: `rb:${TOKEN}:0`, style: "success", text: "Да" },
        { callback_data: `rb:${TOKEN}:1`, style: "danger", text: "Нет" },
      ],
      [
        { callback_data: `rb:${TOKEN}:2`, style: "primary", text: "Позже" },
        { callback_data: `rb:${TOKEN}:3`, text: "Другое" },
      ],
    ] });
    // Telegram limits callback data to 64 bytes.
    for (const row of keyboard.inline_keyboard) {
      for (const button of row) expect(Buffer.byteLength(button.callback_data!)).toBeLessThanOrEqual(64);
    }
  });

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
