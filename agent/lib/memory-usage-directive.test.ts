/**
 * Reading the memory-usage line out of an answer.
 *
 * Constructs covered:
 * - The service line never survives into the text a person reads.
 * - An empty declaration is distinguishable from no declaration at all.
 * - Only well-formed refs are taken; prose around them is ignored.
 * - A line inside fenced or indented code is content, not a directive.
 */
import { describe, expect, it } from "vitest";

import { readMemoryUsageDirective } from "./memory-usage-directive.js";

const FIRST = "mem_0123456789abcdef0123456789abcdef";
const SECOND = "mem_fedcba9876543210fedcba9876543210";

describe("readMemoryUsageDirective", () => {
  it("takes the refs and leaves the answer without the line", () => {
    const result = readMemoryUsageDirective(
      `Код домофона 4271.\n\n[память: ${FIRST}, ${SECOND}]`,
    );

    expect(result).toEqual({
      answer: "Код домофона 4271.",
      declared: true,
      memoryRefs: [FIRST, SECOND],
    });
  });

  it("separates «nothing helped» from «nothing was said»", () => {
    const empty = readMemoryUsageDirective("Не знаю.\n\n[память: нет]");
    const silent = readMemoryUsageDirective("Не знаю.");

    expect({ declared: empty.declared, refs: empty.memoryRefs })
      .toEqual({ declared: true, refs: [] });
    expect({ declared: silent.declared, refs: silent.memoryRefs })
      .toEqual({ declared: false, refs: [] });
  });

  it("never leaves the line in the text a person reads", () => {
    for (const answer of [
      `Ответ.\n[память: ${FIRST}]`,
      `[память: ${FIRST}]`,
      `Ответ.\n\n[ПАМЯТЬ: ${FIRST}]`,
      `Первая строка.\n\nВторая.\n[память:  ${FIRST} ]`,
    ]) {
      expect(readMemoryUsageDirective(answer).answer).not.toMatch(/память:/iu);
    }
  });

  it("ignores a repeated ref and anything that is not one", () => {
    const result = readMemoryUsageDirective(
      `Ответ.\n[память: ${FIRST}, ${FIRST}, mem_short, просто слова]`,
    );

    expect(result.memoryRefs).toEqual([FIRST]);
  });

  it("leaves an indented line alone, because that is code and not transport", () => {
    const answer = `Вот пример строки:\n\n    [память: ${FIRST}]`;

    expect(readMemoryUsageDirective(answer))
      .toEqual({ answer, declared: false, memoryRefs: [] });
  });

  it("keeps the rest of a long answer intact", () => {
    const body = "Первый абзац.\n\nВторой абзац со списком:\n- пункт\n- ещё пункт";

    expect(readMemoryUsageDirective(`${body}\n\n[память: ${SECOND}]`).answer).toBe(body);
  });
});
