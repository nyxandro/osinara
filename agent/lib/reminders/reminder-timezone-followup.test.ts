/**
 * The words of the bot's questions about a timezone (#451).
 *
 * Constructs covered:
 * - The first question names the reminder and its day; the second, on the reminder's day, works as
 *   a hint by itself; several waits are listed in one message.
 */
import { describe, expect, it } from "vitest";

import { followupText } from "./reminder-timezone-followup.js";

describe("followupText", () => {
  it("names the reminder, its day and the suggested zone", () => {
    expect(followupText([{ content: "Приём у врача", localFirstRun: "2026-11-04T12:20:00" }], "Москва", 1)).toBe(
      "Напоминание «Приём у врача» (среда, 4 ноября, 12:20) пока не поставлено: я не знаю ваш часовой пояс. Ваш пояс — Москва?",
    );
  });

  it("says what is today in the second question", () => {
    expect(followupText([{ content: "Приём у врача", localFirstRun: "2026-11-04T13:20:00" }], "Москва", 2)).toBe(
      "Сегодня у вас «Приём у врача» в 13:20, но напоминание так и не поставлено — не знаю ваш часовой пояс. Если ваш пояс — Москва, нажмите кнопку, и я поставлю.",
    );
  });

  it("lists several waits and shortens a long text", () => {
    const text = followupText([
      { content: "Полить цветы", localFirstRun: "2026-11-05T09:00:00" },
      { content: "А".repeat(80), localFirstRun: "2026-11-06T18:00:00" },
    ], "Москва", 1);
    expect(text).toBe(
      `Пока не поставлены напоминания: «Полить цветы» (четверг, 5 ноября, 09:00), «${"А".repeat(59)}…» (пятница, 6 ноября, 18:00) — не знаю ваш часовой пояс. Ваш пояс — Москва?`,
    );
  });
});
