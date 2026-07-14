/**
 * Telegram model-message delivery policy tests.
 *
 * Constructs covered:
 * - `completedTelegramMessage`: keeps concise model-authored progress before tool calls.
 * - Plain and namespaced MiniMax thinking tags never cross the Telegram boundary.
 * - Empty model steps remain invisible to avoid technical Telegram noise.
 */
import { describe, expect, it } from "vitest";

import { completedTelegramMessage } from "./telegram-progress.js";

describe("completedTelegramMessage", () => {
  it("delivers model-authored progress before a long tool step", () => {
    expect(
      completedTelegramMessage({
        finishReason: "tool-calls",
        message: "Собрал информацию. Теперь формирую документ.",
      }),
    ).toBe("Собрал информацию. Теперь формирую документ.");
  });

  it("does not expose an empty technical tool step", () => {
    expect(
      completedTelegramMessage({ finishReason: "tool-calls", message: "   " }),
    ).toBeNull();
  });

  it("removes complete and unclosed MiniMax thinking blocks", () => {
    expect(
      completedTelegramMessage({
        finishReason: "stop",
        message: "<think>Внутреннее рассуждение</think>\n\nГотовый ответ",
      }),
    ).toBe("Готовый ответ");
    expect(
      completedTelegramMessage({
        finishReason: "length",
        message: "<think>Незавершённое внутреннее рассуждение",
      }),
    ).toBeNull();
  });

  it("removes every namespaced MiniMax thinking block embedded between visible text", () => {
    expect(
      completedTelegramMessage({
        finishReason: "stop",
        message: [
          "<mm:think>Первое внутреннее рассуждение</mm:think>",
          "Промежуточный результат",
          "<mm:think>Второе внутреннее рассуждение</mm:think>",
          "Готовый ответ",
        ].join("\n"),
      }),
    ).toBe("Промежуточный результат\n\nГотовый ответ");

    expect(
      completedTelegramMessage({
        finishReason: "length",
        message: "<mm:think>Незавершённое внутреннее рассуждение",
      }),
    ).toBeNull();
  });

  it("removes reasoning before MiniMax's orphan namespaced closing marker", () => {
    expect(
      completedTelegramMessage({
        finishReason: "stop",
        message:
          "Пользователь спрашивает о Telegram API.</mm:think>\n\nПонял вопрос. Вот готовый ответ.",
      }),
    ).toBe("Понял вопрос. Вот готовый ответ.");
  });

  it("rejoins visible text split by duplicated reasoning and orphan closing markers", () => {
    expect(
      completedTelegramMessage({
        finishReason: "stop",
        message: [
          "<think>Пользователь спрашивает, как у меня дела.</think>",
          "В",
          "</think>",
          " у меня дела. Это повтор внутреннего рассуждения.",
          "</think>сё отлично, готов помогать!",
        ].join("\n"),
      }),
    ).toBe("Всё отлично, готов помогать!");
  });
});
