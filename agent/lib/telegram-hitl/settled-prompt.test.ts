/**
 * Settled prompt tests.
 *
 * Constructs covered:
 * - `settledPromptText`: removes the forward-looking consequence of every composed window.
 * - A prompt from an older release keeps its full text instead of losing its last block.
 * - `boundSettledPrompt`: fits the Telegram limit without splitting a surrogate pair.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONSEQUENCE,
  GOOGLE_WORKSPACE_CONSEQUENCE,
} from "./approval-consequences.js";
import { buildApprovalMessage } from "./approval-message.js";
import { boundSettledPrompt, settledPromptText } from "./settled-prompt.js";

describe("settledPromptText", () => {
  it("removes the default consequence once the request is settled", () => {
    const prompt = buildApprovalMessage({
      actionLabel: "изменить напоминание",
      facts: ["ID: 1"],
    });
    expect(prompt).toContain(DEFAULT_CONSEQUENCE);

    const settled = settledPromptText(prompt);
    expect(settled).not.toContain("будет выполнено один раз");
    expect(settled).toBe("Подтверждение: изменить напоминание.\n\nID: 1");
  });

  it("removes a per-tool consequence too", () => {
    const prompt = buildApprovalMessage({
      actionLabel: "изменение в Google Workspace",
      consequence: GOOGLE_WORKSPACE_CONSEQUENCE,
      facts: ["Сервис: Gmail"],
    });
    expect(settledPromptText(prompt)).toBe(
      "Подтверждение: изменение в Google Workspace.\n\nСервис: Gmail",
    );
  });

  it("leaves a prompt with no known consequence intact", () => {
    // Структурная обрезка последнего блока съела бы у такого промпта параметры.
    const other = "Подтвердите действие: удалить файл.\n\nПуть: notes/plan.md";
    expect(settledPromptText(other)).toBe(other);
  });
});

describe("boundSettledPrompt", () => {
  it("keeps a prompt that already fits", () => {
    expect(boundSettledPrompt("короткий", 100)).toBe("короткий");
  });

  it("never splits a surrogate pair", () => {
    const emoji = "🙂".repeat(50);
    for (let limit = 2; limit <= emoji.length; limit += 1) {
      const bounded = boundSettledPrompt(emoji, limit);
      expect(bounded.length).toBeLessThanOrEqual(limit);
      // Одиночный суррогат Telegram отвергнет, и решённое окно останется со старыми кнопками.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
        .test(bounded)).toBe(false);
    }
  });
});
