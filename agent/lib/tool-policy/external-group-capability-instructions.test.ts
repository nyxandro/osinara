/**
 * External-group capability instruction tests.
 *
 * Constructs covered:
 * - `externalGroupCapabilityInstructions`: binds the group to the tools sent with the request and the
 *   skills of the Available skills section, without listing either again.
 * - Delegation is described only when the application core is issued.
 */
import { describe, expect, it } from "vitest";

import { externalGroupCapabilityInstructions } from "./external-group-capability-instructions.js";

describe("externalGroupCapabilityInstructions", () => {
  it("binds the turn to the tools and skills it was given without listing them again", () => {
    // The tool definitions and the skills section already reach the model; a second list cost about
    // 4,800 characters in every request of a fully granted group.
    const markdown = externalGroupCapabilityInstructions({ includeApplicationCore: true });

    expect(markdown).toContain("<external_group_capabilities>");
    expect(markdown).toMatch(/only the tools sent with this request/u);
    expect(markdown).toMatch(/Available skills/u);
    expect(markdown).toMatch(/do not call, offer or claim/iu);
    expect(markdown).not.toMatch(/`[a-z_]+`/u);
    expect(markdown).not.toMatch(/[—–«»]/u);
  });

  it("describes delegation only when the application core is issued", () => {
    expect(externalGroupCapabilityInstructions({ includeApplicationCore: true })).toContain("delegate");
    expect(externalGroupCapabilityInstructions({ includeApplicationCore: false })).not.toContain("delegate");
  });

  it("keeps a granted skill from carrying someone else's authorization", () => {
    expect(externalGroupCapabilityInstructions({ includeApplicationCore: false }))
      .toContain("A permitted skill does not grant anyone else's authorization");
  });
});
