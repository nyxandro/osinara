/**
 * External-group effective capability instruction tests.
 *
 * Constructs covered:
 * - `externalGroupCapabilityInstructions`: renders exact model-visible effective capabilities.
 * - Action-level memory grants remain granular and do not imply sibling actions.
 * - Application-core descriptors are included in the same exact effective surface.
 * - Skill loading is advertised only for the exact live group grants.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));

import { externalGroupCapabilityInstructions } from "./external-group-capability-instructions.js";

describe("externalGroupCapabilityInstructions", () => {
  it("includes always-available files and only explicitly allowed application capabilities", () => {
    const markdown = externalGroupCapabilityInstructions(
      new Set(["remember", "manage_memory.undo"]),
      new Set(),
    );

    expect(markdown).toContain("`glob`");
    expect(markdown).toContain("`grep`");
    expect(markdown).toContain("`read_file`");
    expect(markdown).toContain("`write_file`");
    expect(markdown).toContain("`remember`");
    expect(markdown).toContain("`manage_memory` с `action=undo`");
    expect(markdown).toContain(
      "Effective allowlist: `glob`, `grep`, `read_file`, `write_file`, `manage_memory` с `action=undo`, `remember`.",
    );
    expect(markdown).not.toContain("`manage_memory` с `action=edit`");
    expect(markdown).not.toContain("`manage_memory` с `action=delete`");
    expect(markdown).not.toContain("`search_memories`");
  });

  it("uses the executable manage_memory_thread name for action-level grants", () => {
    const markdown = externalGroupCapabilityInstructions(
      new Set(["manage_memory_thread.complete", "manage_memory_thread.reactivate"]),
      new Set(),
    );

    expect(markdown).toContain("`manage_memory_thread` с `action=complete`");
    expect(markdown).toContain("`manage_memory_thread` с `action=reactivate`");
    expect(markdown).not.toContain("`manage_memory_thread.complete`");
  });

  it("includes independently issued application-core and scheduled-history tools", () => {
    const markdown = externalGroupCapabilityInstructions(new Set(), new Set(), {
      includeApplicationCore: true,
      scheduledHistory: true,
      scheduledRun: false,
    });

    expect(markdown).toContain("`read_profile_view`");
    expect(markdown).toContain("`manage_behavior_preference`");
    expect(markdown).toContain("`read_scheduled_group_history`");
    expect(markdown).not.toMatch(/не вызывай.*другие видимые static descriptors/isu);
  });

  it("does not advertise interactive preferences during a scheduled run", () => {
    const markdown = externalGroupCapabilityInstructions(new Set(), new Set(), {
      includeApplicationCore: true,
      scheduledHistory: true,
      scheduledRun: true,
    });

    expect(markdown).toContain("`read_profile_view`");
    expect(markdown).toContain("`read_scheduled_group_history`");
    expect(markdown).not.toContain("`manage_behavior_preference`");
  });

  it("forbids offering any other visible static descriptor", () => {
    const markdown = externalGroupCapabilityInstructions(new Set(), new Set());

    expect(markdown).toMatch(
      /не вызывай, не предлагай и не утверждай, что можешь использовать инструменты, не перечисленные выше/iu,
    );
  });

  it("advertises executable load_skill only with an exact live skill grant", () => {
    const withoutSkills = externalGroupCapabilityInstructions(new Set(), new Set());
    const withPohuy = externalGroupCapabilityInstructions(new Set(), new Set(["pohuy"]));

    expect(withoutSkills).not.toContain("`load_skill`");
    expect(withoutSkills).not.toContain("`pohuy`");
    expect(withPohuy).toContain("`load_skill` с `skill=pohuy`");
    expect(withPohuy).toContain("Effective skill allowlist: `pohuy`.");
  });

  it("advertises imagegen instructions only with generate_image", () => {
    const denied = externalGroupCapabilityInstructions(new Set(), new Set());
    const granted = externalGroupCapabilityInstructions(new Set(["generate_image"]), new Set());
    const scheduled = externalGroupCapabilityInstructions(new Set(["generate_image"]), new Set(), {
      includeApplicationCore: true,
      scheduledHistory: true,
      scheduledRun: true,
    });

    expect(denied).not.toContain("skill=imagegen");
    expect(granted).toContain("`load_skill` с `skill=imagegen`");
    expect(granted).toContain("Effective skill allowlist: `imagegen`.");
    expect(scheduled).not.toContain("skill=imagegen");
    expect(scheduled).not.toContain("`generate_image`");
  });

  it("marks static trusted-only Google Workspace skills as unavailable externally", () => {
    const markdown = externalGroupCapabilityInstructions(new Set(), new Set());

    expect(markdown).toMatch(/Google Workspace.*не доступны.*внешн/iu);
    expect(markdown).not.toMatch(/`gws-[^`]+`/u);
  });
});
