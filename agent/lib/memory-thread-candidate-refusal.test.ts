/**
 * The answer `remember` gives when a similar thread already exists.
 *
 * Constructs covered:
 * - The refusal names the candidates and the way forward instead of a generic failure.
 */
import { describe, expect, it } from "vitest";

import { memoryThreadCandidateRefusalResult } from "./memory-thread-candidate-refusal.js";
import { MemoryThreadCandidateError } from "./memory-thread-write.js";

describe("thread candidate refusal", () => {
  it("answers with the candidates, attach first and one refined retry", () => {
    const result = memoryThreadCandidateRefusalResult(new MemoryThreadCandidateError([
      { threadRef: "thread_00000000000000000000000000000001", title: "Марафон" },
    ]));

    expect(result).toMatchObject({
      candidates: [{ threadRef: "thread_00000000000000000000000000000001", title: "Марафон" }],
      code: "AGENT_MEMORY_THREAD_CANDIDATE_EXISTS",
      saved: false,
    });
    expect(result.correction).toContain("action=attach");
    expect(result.correction).toContain("одна повторная попытка");
    // A generic failure told the model not to repeat the call, against the attach it needs.
    expect(result.correction).not.toContain("Не повторяйте");
  });
});
