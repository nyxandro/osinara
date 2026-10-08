/**
 * Reading the day or period a question is about.
 *
 * Constructs covered:
 * - The explicit forms of the synthetic date questions and of live chat map to their days.
 * - A day or month without a year is the latest one not in the future.
 * - Phrases that name no day leave the selection as it was.
 * - Property: every window a question names lies within the past, ends no later than today and
 *   starts no later than it ends; «N дней назад» is exactly the day N days before today.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { localDate, memoryDateWindow } from "./memory-date-question.js";

const TODAY = "2026-10-08"; // a Thursday

describe("memoryDateWindow", () => {
  it.each([
    ["Что было вчера?", "yesterday", "2026-10-07", "2026-10-07"],
    ["осинара, мия, а что вчера в чатике было интересного и важного?", "yesterday", "2026-10-07", "2026-10-07"],
    ["Осинара, напомни, что мы делали позавчера", "day_before_yesterday", "2026-10-06", "2026-10-06"],
    ["что обсуждали 5 дней назад", "days_ago", "2026-10-03", "2026-10-03"],
    ["Что у нас случилось неделю назад?", "week_ago", "2026-09-30", "2026-10-02"],
    ["о чём договорились на прошлой неделе?", "last_week", "2026-09-28", "2026-10-04"],
    ["что мы сделали на этой неделе", "this_week", "2026-10-05", "2026-10-08"],
    ["что было в прошлом месяце", "last_month", "2026-09-01", "2026-09-30"],
    ["что было в этом месяце", "this_month", "2026-10-01", "2026-10-08"],
    ["Что мы делали в июне 2025 года?", "month", "2025-06-01", "2025-06-30"],
    ["что решали в августе?", "month", "2026-08-01", "2026-08-31"],
    // A month still ahead this year means last year's.
    ["что было в декабре?", "month", "2025-12-01", "2025-12-31"],
    ["в октябре что было", "month", "2026-10-01", "2026-10-08"],
    ["Что произошло 3 марта?", "day", "2026-03-03", "2026-03-03"],
    ["что было 9-го ноября", "day", "2025-11-09", "2025-11-09"],
    ["что было 12 мая 2024", "day", "2024-05-12", "2024-05-12"],
  ])("reads «%s» as %s", (question, form, from, to) => {
    expect(memoryDateWindow(question, TODAY)).toEqual({ form, from, to });
  });

  it.each([
    "Какая сегодня погода?", "что было в прошлый раз", "недавно говорили про ключи", "Март — хорошее имя",
    "майские праздники", "31 февраля", "что будет 3 марта 2027", "1000 дней назад", "Где живёт Тимур?", "",
  ])("names no day in «%s»", (question) => {
    expect(memoryDateWindow(question, TODAY)).toBeNull();
  });

  it("keeps every window in the past, and «N дней назад» on exactly that day", () => {
    const today = fc.date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2030-12-31T00:00:00Z"), noInvalidDate: true })
      .map((date) => date.toISOString().slice(0, 10));
    const month = fc.constantFrom("январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе",
      "сентябре", "октябре", "ноябре", "декабре");
    const genitive = fc.constantFrom("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
      "сентября", "октября", "ноября", "декабря");
    const question = fc.oneof(
      fc.constantFrom("что было вчера", "позавчера что делали", "неделю назад", "на прошлой неделе",
        "на этой неделе", "в прошлом месяце", "в этом месяце"),
      month.map((word) => `что было в ${word}?`),
      fc.tuple(fc.integer({ min: 1, max: 31 }), genitive).map(([dayOfMonth, word]) => `что было ${dayOfMonth} ${word}`),
    );

    fc.assert(fc.property(today, question, (current, text) => {
      const window = memoryDateWindow(text, current);
      if (window === null) return; // «31 апреля» and the like name no day
      expect(window.from <= window.to).toBe(true);
      expect(window.to <= current).toBe(true);
      expect(Number.isNaN(Date.parse(window.from))).toBe(false);
    }));
    fc.assert(fc.property(today, fc.integer({ min: 1, max: 366 }), (current, days) => {
      const expected = new Date(Date.parse(`${current}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
      expect(memoryDateWindow(`что было ${days} дней назад`, current)).toEqual({
        form: "days_ago", from: expected, to: expected,
      });
    }), { examples: [["2026-03-01", 1], ["2024-03-01", 1], ["2026-01-01", 366]] });
  });
});

describe("localDate", () => {
  it("reads the calendar day where the person is", () => {
    const lateEvening = new Date("2026-10-07T22:30:00.000Z");

    expect(localDate(lateEvening, null)).toBe("2026-10-07");
    expect(localDate(lateEvening, "Europe/Moscow")).toBe("2026-10-08");
  });
});
