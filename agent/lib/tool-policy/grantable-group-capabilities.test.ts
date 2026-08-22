/**
 * External group grant-surface tests for the direct-provider runtime.
 *
 * Constructs covered:
 * - A provider without subscription image generation removes the capability from the grant surface.
 * - Persisted grants stay parseable so a stale row never invalidates the surrounding policy.
 * - Status selection splits a persisted allowlist into round-trippable and inert entries.
 */
import { describe, expect, it, vi } from "vitest";

// The premise is stated rather than inherited from the checked-in provider config, so switching the
// repository default cannot silently turn this suite into an assertion about the opposite runtime.
vi.mock("../image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: false,
}));

import {
  GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES,
  isGrantableExternalGroupToolName,
  selectGrantableExternalGroupTools,
} from "./grantable-group-capabilities.js";
import {
  EXTERNAL_GROUP_TOOL_NAMES,
  isSubscriptionOnlyExternalGroupToolName,
  parseExternalGroupToolAllowlist,
} from "./group-tool-catalog.js";

describe("grantable external group capabilities without a Codex subscription", () => {
  it("removes subscription image generation from the grant surface", () => {
    expect(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES).not.toContain("generate_image");
    expect(isGrantableExternalGroupToolName("generate_image")).toBe(false);
    expect(isGrantableExternalGroupToolName("search_memories")).toBe(true);
  });

  it("keeps every other catalog capability grantable", () => {
    expect([...GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES]).toEqual(
      EXTERNAL_GROUP_TOOL_NAMES.filter((name) => !isSubscriptionOnlyExternalGroupToolName(name)),
    );
    expect(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it("still parses a grant persisted under the previous provider", () => {
    // Dropping the whole policy would silently revoke unrelated capabilities of a live group.
    expect(parseExternalGroupToolAllowlist(["generate_image", "remember"]))
      .toEqual(new Set(["generate_image", "remember"]));
  });

  it("splits a persisted allowlist into effective and inert grants", () => {
    expect(selectGrantableExternalGroupTools(["remember", "generate_image", "web_fetch"])).toEqual({
      effective: ["remember", "web_fetch"],
      unavailable: ["generate_image"],
    });
    expect(selectGrantableExternalGroupTools(["remember"])).toEqual({
      effective: ["remember"],
      unavailable: [],
    });
  });

  it("reports an unrecognized persisted name instead of trimming it away", () => {
    // Such a row makes `parseExternalGroupToolAllowlist` deny the whole policy, so a status that
    // hid it would look healthy while the group actually has no capability at all.
    expect(selectGrantableExternalGroupTools(["remember", "retired_capability"])).toEqual({
      effective: ["remember"],
      unavailable: ["retired_capability"],
    });
  });
});
