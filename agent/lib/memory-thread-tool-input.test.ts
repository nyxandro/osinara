import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import manageMemoryThread from "./tools/manage_memory_thread.js";

const THREAD = `thread_${"a".repeat(32)}`;
const ENTRY = `entry_${"b".repeat(32)}`;
const OUTCOME = `outcome_${"c".repeat(32)}`;

function accepts(input: Record<string, unknown>): boolean {
  return (manageMemoryThread.inputSchema as unknown as ZodType).safeParse(input).success;
}

describe("manage_memory_thread input", () => {
  it("offers only completion grounds that can prove a thread is done", () => {
    expect(accepts({ action: "complete", authority: "current_user_statement", sourceEntryRefs: [ENTRY], threadRef: THREAD })).toBe(true);
    expect(accepts({ action: "complete", authority: "confirmed_outcome", outcomeRef: OUTCOME, sourceEntryRefs: [ENTRY], threadRef: THREAD }))
      .toBe(true);
    // A formal goal condition needs an outcome only an application integration could create, and none exists.
    expect(accepts({ action: "complete", authority: "formal_goal_condition", outcomeRef: OUTCOME, sourceEntryRefs: [ENTRY], threadRef: THREAD }))
      .toBe(false);
  });
});
