/**
 * Telegram model-message delivery policy tests.
 *
 * Constructs covered:
 * - `completedTelegramMessage`: keeps concise model-authored progress before tool calls.
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

  it("trims surrounding whitespace from a delivered message", () => {
    expect(
      completedTelegramMessage({ finishReason: "stop", message: "\n\nГотовый ответ  " }),
    ).toBe("Готовый ответ");
  });

  it.each([
    { finishReason: "tool-calls", message: "   " },
    { finishReason: "stop", message: "" },
    { finishReason: "stop", message: null },
    { finishReason: "stop" },
  ])("does not expose an empty technical step %#", (data) => {
    expect(completedTelegramMessage(data)).toBeNull();
  });
});
