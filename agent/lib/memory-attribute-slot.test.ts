/**
 * The slot name as the model writes it, checked before anything is stored.
 *
 * Constructs covered:
 * - `normalizeMemoryAttribute`: a word that means «no value» is refused rather than becoming a
 *   slot, whatever its case and spacing; a real name that merely contains such a word is kept.
 * - A discussion summary is stored under one spelling of its name, so «итог:отпуск» and
 *   «Итог : отпуск» are the same summary; a summary name without a topic is refused.
 *
 * Ten production records carried the slot "null" (23.09 and 02.10.2026), and three of them were
 * retired by unrelated facts that happened to carry the same "null" about the same person.
 */
import { describe, expect, it } from "vitest";

import type { AppError } from "./app-error.js";
import { normalizeMemoryAttribute } from "./memory-attribute-slot.js";

describe("normalizeMemoryAttribute", () => {
  it.each(["null", "NULL", " None ", "undefined"])("refuses %j instead of making it a slot", (value) => {
    expect(() => normalizeMemoryAttribute(value, "fact")).toThrow(
      expect.objectContaining<Partial<AppError>>({ code: "AGENT_MEMORY_ATTRIBUTE_INVALID" }),
    );
  });

  it("keeps a real name that only contains such a word", () => {
    expect(normalizeMemoryAttribute("Null Safety", "preference")).toBe("null safety");
  });

  it("stores one spelling of a discussion summary's name", () => {
    for (const spelling of ["итог:отпуск летом", "Итог : отпуск  летом", "ИТОГ:  отпуск летом"]) {
      expect(normalizeMemoryAttribute(spelling, "fact")).toBe("итог: отпуск летом");
    }
    expect(normalizeMemoryAttribute("итоговая оценка", "fact")).toBe("итоговая оценка");
  });

  it.each(["итог", "итог обсуждения", "Итоги встречи", "итог:"])("refuses the summary name %j that names no topic", (value) => {
    expect(() => normalizeMemoryAttribute(value, "fact")).toThrow(
      expect.objectContaining<Partial<AppError>>({ code: "AGENT_MEMORY_ATTRIBUTE_INVALID" }),
    );
  });
});
