/**
 * What a person sees of an answer while the model writes it.
 *
 * Constructs covered:
 * - The text so far goes through the same filter as a delivered answer; what only the backend reads
 *   never shows: a reaction, a silence, a reply choice, the memory line, reasoning, button markup,
 *   a file path, an unfinished tag or link at the end.
 * - A file shows as a line with its caption; of an answer split into messages, the last part shows.
 * - Property: whatever prefix of an answer the model has written, the preview holds none of it.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { previewAnswerText } from "./answer-draft-preview.js";

describe("previewAnswerText", () => {
  it.each([
    ["a reaction", "<telegram-reaction>❤️</telegram-reaction>"],
    ["the start of a reaction", "<telegr"],
    ["a silence", "<empty-delivery/>"],
    ["the start of a reply choice", "[[no-re"],
    ["blank text", "\n\n  "],
    ["reasoning alone", "<think>планирую"],
    ["buttons alone", "<tg-button-row><tg-button>Да</tg-button>"],
  ])("shows nothing yet for %s", (_case, text) => {
    expect(previewAnswerText(text)).toBeNull();
  });

  it("shows the answer after a reply choice and leading blank lines", () => {
    expect(previewAnswerText("[[no-reply]]\nОбъявление для всех")).toBe("Объявление для всех");
    expect(previewAnswerText("\n\n391")).toBe("391");
  });

  it("drops reasoning, finished or not", () => {
    expect(previewAnswerText("<think>мысль</think>Ответ")).toBe("Ответ");
    expect(previewAnswerText("Ищу<think>план")).toBe("Ищу");
  });

  it("cuts the buttons and an unfinished tag, link or file at the end", () => {
    expect(previewAnswerText("Заказываем?\n\n<tg-button-row><tg-but")).toBe("Заказываем?");
    expect(previewAnswerText("Рецепт\n\n![Рецепты](/workspace/fam")).toBe("Рецепт");
    expect(previewAnswerText("Смотри [сайт](https://exa")).toBe("Смотри");
    expect(previewAnswerText("Созвон <tg-time at=\"2026-11-07T19:00:00+03:00\" format=\"wt\">суббо")).toBe("Созвон");
    expect(previewAnswerText("Итог [память: mem_0123")).toBe("Итог");
    expect(previewAnswerText("Первое\n\n[[split]")).toBe("Первое");
    expect(previewAnswerText("Готово <b")).toBe("Готово");
  });

  it("shows a file as a line with its caption or name", () => {
    expect(previewAnswerText("Рецепт\n\n![Рецепты на неделю](/workspace/family/r.md)")).toBe("Рецепт\n\n📎 Рецепты на неделю");
    expect(previewAnswerText("Отчёт:\n\n![](</workspace/personal/Мой отчёт.pdf>)")).toBe("Отчёт:\n\n📎 Мой отчёт.pdf");
  });

  it("shows a moment in Telegram's form and leaves out the memory line", () => {
    expect(previewAnswerText("Созвон <tg-time at=\"2026-11-07T19:00:00+03:00\" format=\"wt\">суббота, 19:00</tg-time>.\n\n[память: mem_0123456789abcdef0123456789abcdef]"))
      .toBe("Созвон <tg-time unix=\"1794067200\" format=\"wt\">суббота, 19:00</tg-time>.");
  });

  it("shows only the last part of an answer split into messages", () => {
    expect(previewAnswerText("Первое сообщение.\n\n[[split]]\n\nВторое")).toBe("Второе");
  });

  it("keeps a link the filter would not open dead in the preview too", () => {
    expect(previewAnswerText("Профиль: [бот](tg://resolve?domain=evil)")).toBe("Профиль: бот (tg://resolve?domain=evil)");
  });
});

// What a final answer is made of, including everything only the backend may read. Code is left out:
// in code the delivered answer, too, shows a directive or a path as written.
const ANSWER_PIECE = fc.constantFrom(
  "Ответ ", "**жирный** ", "\n\n", "\n", "- пункт\n", "<think>мысль</think>", "<think>", "</think>",
  "<tg-button-row><tg-button style=\"success\">✅ Да</tg-button></tg-button-row>", "![Фото](/workspace/family/a.jpg)",
  "![](</workspace/personal/Мой файл.pdf>)", "[память: mem_0123456789abcdef0123456789abcdef]", "[[split]]\n",
  "<tg-time at=\"2026-11-07T19:00:00+03:00\" format=\"wt\">сб</tg-time>",
);
const ANSWER = fc.array(ANSWER_PIECE, { maxLength: 14 }).map((pieces) => pieces.join(""));

describe("preview property", () => {
  it("never shows what only the backend reads, whatever prefix the model has written", () => {
    fc.assert(fc.property(ANSWER, fc.nat(), (answer, cut) => {
      const prefix = answer.slice(0, answer.length === 0 ? 0 : cut % (answer.length + 1));
      const preview = previewAnswerText(prefix);
      if (preview === null) return;
      for (const hidden of ["/workspace/", "tg-button", "think>", "[память", "telegram-reaction", "empty-delivery", "[[split"]) {
        expect(preview, JSON.stringify(prefix)).not.toContain(hidden);
      }
    }), { numRuns: 500 });
  });
});
