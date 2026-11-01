/**
 * External group grant-surface tests.
 *
 * Constructs covered:
 * - Seeing what participants send is no grant: images and attachments are baseline access of every
 *   external group, so the owner is offered neither, whatever model is active.
 * - Persisted grants stay parseable so a stale row never invalidates the surrounding policy.
 * - Status selection splits a persisted allowlist into round-trippable and inert entries.
 * - A persisted grant that became baseline access (page reading, sending a group file, images,
 *   attachments) still parses and is neither offered nor reported as unavailable.
 */
import { describe, expect, it } from "vitest";

import {
  GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES,
  isGrantableExternalGroupToolName,
  selectGrantableExternalGroupTools,
} from "./grantable-group-capabilities.js";
import {
  BASELINE_EXTERNAL_GROUP_GRANTS,
  EXTERNAL_GROUP_TOOL_NAMES,
  parseExternalGroupToolAllowlist,
} from "./group-tool-catalog.js";

describe("grantable external group capabilities", () => {
  it("offers no grant for seeing images and attachments: every group has both", () => {
    for (const name of ["inspect_workspace_image", "import_telegram_attachment"] as const) {
      expect(BASELINE_EXTERNAL_GROUP_GRANTS.has(name), name).toBe(true);
      expect(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES, name).not.toContain(name);
      expect(isGrantableExternalGroupToolName(name), name).toBe(false);
    }
    expect(isGrantableExternalGroupToolName("search_memories")).toBe(true);
  });

  it("offers every catalog capability that is not baseline access", () => {
    expect([...GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES]).toEqual(
      EXTERNAL_GROUP_TOOL_NAMES.filter((name) => !BASELINE_EXTERNAL_GROUP_GRANTS.has(name)),
    );
    expect(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it("keeps persisted baseline grants parseable without offering or reporting them", () => {
    // Live external groups hold them: an unknown name would invalidate their whole policies.
    const persisted = ["send_workspace_file", "inspect_workspace_image", "import_telegram_attachment", "remember"];
    expect(parseExternalGroupToolAllowlist(persisted)).toEqual(new Set(persisted));
    expect(isGrantableExternalGroupToolName("send_workspace_file")).toBe(false);
    expect(selectGrantableExternalGroupTools([...persisted, "web_fetch"]))
      .toEqual({ effective: ["remember"], unavailable: [] });
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
