/**
 * Telegram model-message delivery policy tests.
 *
 * Constructs covered:
 * - `completedTelegramMessage`: keeps concise model-authored progress before tool calls.
 * - MiniMax thinking tags never cross the user-visible Telegram boundary.
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
});
