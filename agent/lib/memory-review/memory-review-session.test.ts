/**
 * Memory-review session identification tests.
 *
 * Constructs covered:
 * - `isMemoryReviewSession`: only the internal background review is a review session; a chat turn
 *   carries no mode, and the retired interactive mode is malformed authorization (#569).
 */
import { describe, expect, it } from "vitest";

import { isMemoryReviewSession } from "./memory-review-session.js";

function context(attributes: Record<string, string>) {
  return { session: { auth: { current: { attributes } } } } as never;
}

describe("isMemoryReviewSession", () => {
  it("recognizes the background review and an ordinary turn", () => {
    expect(isMemoryReviewSession(context({ memoryReviewMode: "background" }))).toBe(true);
    expect(isMemoryReviewSession(context({}))).toBe(false);
  });

  it("refuses the retired interactive mode", () => {
    expect(() => isMemoryReviewSession(context({ memoryReviewMode: "interactive" })))
      .toThrow("AGENT_MEMORY_REVIEW_CONTEXT_INVALID");
  });
});
