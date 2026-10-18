/**
 * The slot name as the model writes it, checked before anything is stored.
 *
 * Constructs covered:
 * - `normalizeMemoryAttribute`: a word that means «no value» is refused rather than becoming a
 *   slot, whatever its case and spacing; a real name that merely contains such a word is kept.
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
});
