/**
 * What the model is told when a record names another participant than the one it is bound to.
 *
 * Constructs covered:
 * - `memorySubjectNameMismatchRefusalResult`: names both people, says a retold opinion belongs to whom
 *   it is about, and offers `verified_ref` only where the turn has profile cards (not the silent review).
 */
import { describe, expect, it } from "vitest";

import {
  MemorySubjectNameMismatchRefusal,
  memorySubjectNameMismatchRefusalResult,
} from "./memory-subject-name-mismatch.js";

const refusal = new MemorySubjectNameMismatchRefusal("Олег (@oleg_p)", ["@nina_s"]);

describe("memorySubjectNameMismatchRefusalResult", () => {
  it("names both people and offers a profile reference in an ordinary turn", () => {
    const result = memorySubjectNameMismatchRefusalResult(refusal, { verifiedRefAvailable: true });

    expect(result).toMatchObject({ code: "AGENT_MEMORY_SUBJECT_NAME_MISMATCH", saved: false });
    expect(result.correction).toContain("«Олег (@oleg_p)»");
    expect(result.correction).toContain("(@nina_s)");
    expect(result.correction).toContain("Пересказ чужих слов");
    expect(result.correction).toContain("verified_ref");
  });

  it("offers only a label to the silent review, which has no profile cards", () => {
    const result = memorySubjectNameMismatchRefusalResult(refusal, { verifiedRefAvailable: false });

    expect(result.correction).not.toContain("verified_ref");
    expect(result.correction).toContain("с меткой «Имя (@username)»");
  });
});
