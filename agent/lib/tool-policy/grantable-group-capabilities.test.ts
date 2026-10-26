/**
 * External group grant-surface tests for a runtime whose model does not see images.
 *
 * Constructs covered:
 * - A capability the runtime cannot serve is removed from the grant surface.
 * - Persisted grants stay parseable so a stale row never invalidates the surrounding policy.
 * - Status selection splits a persisted allowlist into round-trippable and inert entries.
 */
import { describe, expect, it, vi } from "vitest";

// The premise is stated rather than inherited from the checked-in provider config, so switching the
// repository default cannot silently turn this suite into an assertion about the opposite runtime.
vi.mock("../model-vision-availability.js", () => ({
  MODEL_VISION_AVAILABLE: false,
}));

import {
  GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES,
  isGrantableExternalGroupToolName,
  selectGrantableExternalGroupTools,
} from "./grantable-group-capabilities.js";
import {
  EXTERNAL_GROUP_TOOL_NAMES,
  externalGroupCapabilityRequirement,
  parseExternalGroupToolAllowlist,
} from "./group-tool-catalog.js";

describe("grantable external group capabilities without an image-capable model", () => {
  it("removes image inspection from the grant surface", () => {
    expect(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES).not.toContain("inspect_workspace_image");
    expect(isGrantableExternalGroupToolName("inspect_workspace_image")).toBe(false);
    expect(isGrantableExternalGroupToolName("search_memories")).toBe(true);
  });

  it("keeps every other catalog capability grantable", () => {
    expect([...GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES]).toEqual(
      EXTERNAL_GROUP_TOOL_NAMES.filter((name) =>
        name !== "web_fetch" && externalGroupCapabilityRequirement(name) !== "vision"
      ),
    );
    expect(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it("still parses a grant persisted under a model that saw images", () => {
    // Dropping the whole policy would silently revoke unrelated capabilities of a live group.
    expect(parseExternalGroupToolAllowlist(["inspect_workspace_image", "remember"]))
      .toEqual(new Set(["inspect_workspace_image", "remember"]));
  });

  it("splits a persisted allowlist into effective and inert grants", () => {
    expect(selectGrantableExternalGroupTools(["remember", "inspect_workspace_image", "web_fetch"])).toEqual({
      effective: ["remember"],
      unavailable: ["inspect_workspace_image"],
    });
    expect(selectGrantableExternalGroupTools(["remember"])).toEqual({
      effective: ["remember"],
      unavailable: [],
    });
  });

  it("reports an unrecognized persisted name instead of trimming it away", () => {
    // Such a row makes `parseExternalGroupToolAllowlist` deny the whole policy, so a status that
    // hid it would look healthy while the group actually has no capability at all.
    expect(selectGrantableExternalGroupTools(["remember", "generate_image"])).toEqual({
      effective: ["remember"],
      unavailable: ["generate_image"],
    });
  });
});
