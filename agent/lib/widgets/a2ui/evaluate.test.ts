/**
 * Computing A2UI values against the data model.
 *
 * Constructs covered:
 * - Bindings, relative paths inside a list item, the recorded reads.
 * - formatString, formatNumber, formatCurrency, pluralize and formatDate in Russian; a moment is
 *   written in its own offset; a moment without an offset and a missing number are errors.
 * - Properties: formatString keeps literal text and puts every value in place; formatDate gives back
 *   the local date and time a moment was written with, for any offset.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { JsonObject } from "./a2ui-types.js";
import { evaluateNumber, evaluateString, type EvaluationScope, WidgetEvaluationError } from "./evaluate.js";

function scope(dataModel: JsonObject, item: string[] | null = null): EvaluationScope {
  return { dataModel, item, reads: new Set() };
}

const at = "/createSurface/components/0/text";

describe("evaluate", () => {
  it("reads bindings, relative paths in a list item, and records what it read", () => {
    const data = scope({ tasks: [{ title: "Купить подарок" }], total: 7 }, ["tasks", "0"]);
    expect(evaluateString({ "@path": "title" }, data, at)).toBe("Купить подарок");
    expect(evaluateString({ "@path": "/total" }, data, at)).toBe("7");
    expect(evaluateString({ "@path": "/missing" }, data, at)).toBe("");
    expect([...data.reads]).toEqual(["/tasks/0/title", "/total", "/missing"]);
  });

  it("formats strings, numbers, amounts and word forms in Russian", () => {
    const data = scope({ count: 3, going: 2, sum: 12345.5 });
    expect(evaluateString({ "@call": "formatString", args: { value: "Идут ${/going} из ${/count}, \\${не путь}" } }, data, at)).toBe("Идут 2 из 3, ${не путь}");
    expect(evaluateString({ "@call": "formatNumber", args: { decimals: 1, value: { "@path": "/sum" } } }, data, at)).toBe("12\u00a0345,5");
    expect(evaluateString({ "@call": "formatCurrency", args: { currency: "RUB", value: 1500 } }, data, at)).toBe("1\u00a0500\u00a0₽");
    const forms = (value: number) => evaluateString({ "@call": "pluralize", args: { few: "занятия", many: "занятий", one: "занятие", other: "занятия", value } }, data, at);
    expect([1, 2, 5, 21, 11].map(forms)).toEqual(["занятие", "занятия", "занятий", "занятие", "занятий"]);
  });

  it("writes a moment in the offset it was given with, and a date without time", () => {
    const data = scope({});
    const date = (value: string, format: string) => evaluateString({ "@call": "formatDate", args: { format, value } }, data, at);
    expect(date("2026-11-10T17:30:00+03:00", "EEEE, d MMMM, HH:mm")).toBe("вторник, 10 ноября, 17:30");
    expect(date("2026-11-10T22:30:00Z", "E d MMM HH:mm")).toBe("вт 10 нояб. 22:30");
    expect(date("2026-12-31", "d MMMM yyyy")).toBe("31 декабря 2026");
  });

  it("refuses a moment without its offset, a time pattern on a date, and a missing number", () => {
    const data = scope({});
    expect(() => evaluateString({ "@call": "formatDate", args: { format: "HH:mm", value: "2026-11-10T17:30:00" } }, data, at)).toThrow(WidgetEvaluationError);
    expect(() => evaluateString({ "@call": "formatDate", args: { format: "HH:mm", value: "2026-11-10" } }, data, at)).toThrow(/has no time/u);
    expect(() => evaluateNumber({ "@path": "/done" }, data, "/createSurface/components/2/value")).toThrow(/no number at \/done/u);
  });

  it("formatString keeps the literal text and puts every value in its place", () => {
    const literal = fc.string({ maxLength: 12 }).filter((text) => !text.includes("$") && !text.includes("\\"));
    const key = fc.constantFrom("a", "b", "c");
    const value = fc.oneof(fc.string({ maxLength: 8 }), fc.integer({ max: 10_000, min: -10_000 }), fc.boolean());
    fc.assert(fc.property(
      fc.array(fc.tuple(literal, key), { maxLength: 6 }),
      literal,
      fc.record({ a: value, b: value, c: value }),
      (parts, tail, data) => {
        const template = parts.map(([text, name]) => `${text}\${/${name}}`).join("") + tail;
        const expected = parts.map(([text, name]) => `${text}${String(data[name])}`).join("") + tail;
        expect(evaluateString({ "@call": "formatString", args: { value: template } }, scope(data), at)).toBe(expected);
      },
    ), { examples: [[[], "", { a: "", b: 0, c: false }], [[["", "a"], ["", "a"]], "", { a: "x", b: 1, c: true }]] });
  });

  it("formatDate gives back the local date and time of a moment for any offset", () => {
    const two = (value: number) => String(value).padStart(2, "0");
    fc.assert(fc.property(
      fc.record({
        day: fc.integer({ max: 28, min: 1 }),
        hour: fc.integer({ max: 23, min: 0 }),
        minute: fc.integer({ max: 59, min: 0 }),
        month: fc.integer({ max: 12, min: 1 }),
        offset: fc.integer({ max: 14 * 60, min: -12 * 60 }).map((minutes) => minutes - (minutes % 15)),
        year: fc.integer({ max: 2099, min: 1971 }),
      }),
      ({ day, hour, minute, month, offset, year }) => {
        const sign = offset < 0 ? "-" : "+";
        const zone = `${sign}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`;
        const moment = `${year}-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}:00${zone}`;
        const shown = evaluateString({ "@call": "formatDate", args: { format: "yyyy-MM-dd HH:mm", value: moment } }, scope({}), at);
        expect(shown).toBe(`${year}-${two(month)}-${two(day)} ${two(hour)}:${two(minute)}`);
      },
    ), { examples: [[{ day: 1, hour: 0, minute: 0, month: 1, offset: -720, year: 2026 }], [{ day: 28, hour: 23, minute: 59, month: 12, offset: 840, year: 2099 }]] });
  });
});
