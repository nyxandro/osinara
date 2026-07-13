/**
 * Root Eve agent configuration tests.
 *
 * Constructs:
 * - Delegation depth zero keeps built-in and declared subagents unavailable to the root model.
 * - Patched Eve runtime treats zero as an reached boundary rather than its default depth.
 */
import { describe, expect, it } from "vitest";

import agent from "../agent.js";
import { resolveSubagentDelegationLimit } from "../../node_modules/eve/dist/src/harness/subagent-depth.js";

describe("root agent configuration", () => {
  it("disables every subagent capability at the framework limit boundary", () => {
    expect(agent.limits?.maxSubagentDepth).toBe(0);
    expect(resolveSubagentDelegationLimit({ subagentMaxDepth: 0 })).toEqual({
      currentDepth: 0,
      maxDepth: 0,
      nextChildDepth: 1,
      reached: true,
    });
  });
});
