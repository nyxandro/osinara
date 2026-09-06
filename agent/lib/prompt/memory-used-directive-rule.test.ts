/**
 * Placement of the used-memory directive rule across modes.
 *
 * Constructs covered:
 * - Private and family modes always carry the rule.
 * - An external group carries it when it can remember or search memory, never without memory.
 */
import { describe, expect, it } from "vitest";

import { modeInstructions } from "./mode-instructions.js";

const RULE_FRAGMENT = "<memory-used>ref,ref</memory-used>";

describe("memory-used directive rule", () => {
  it("is present in private and family modes", () => {
    expect(modeInstructions({ environment: "private" })).toContain(RULE_FRAGMENT);
    expect(modeInstructions({ environment: "family" })).toContain(RULE_FRAGMENT);
  });

  it("follows memory access in an external group", () => {
    expect(modeInstructions({ capabilities: new Set(), environment: "external", skills: new Set() }))
      .not.toContain(RULE_FRAGMENT);
    expect(modeInstructions({ capabilities: new Set(["remember"]), environment: "external", skills: new Set() }))
      .toContain(RULE_FRAGMENT);
    expect(modeInstructions({ capabilities: new Set(["search_memories"]), environment: "external", skills: new Set() }))
      .toContain(RULE_FRAGMENT);
  });
});
