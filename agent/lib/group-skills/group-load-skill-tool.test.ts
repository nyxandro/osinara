/**
 * Execution-time external-group skill authorization tests.
 *
 * Constructs covered:
 * - The runtime's skill loader runs only for a safe skill present in the current live group policy.
 * - Revoked, unknown and malformed requests fail before native skill loading.
 */
import type { ToolContext } from "../../runtime/tool.js";
import { describe, expect, it, vi } from "vitest";

import { createExternalGroupLoadSkillTool } from "./group-load-skill-tool.js";

function context(): ToolContext {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            familyId: "family-1",
            groupId: "group-1",
            groupType: "external",
            role: "external",
          },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
      },
    },
  } as unknown as ToolContext;
}

describe("external group load_skill", () => {
  it("delegates only after a live grant check", async () => {
    const executeNative = vi.fn().mockResolvedValue({ loaded: true });
    const loadGroupSkillAllowlist = vi.fn().mockResolvedValue(new Set(["behavior-preferences"]));
    const tool = createExternalGroupLoadSkillTool({ executeNative, loadGroupSkillAllowlist });

    await expect(tool.execute({ skill: "behavior-preferences" }, context())).resolves.toEqual({ loaded: true });
    expect(loadGroupSkillAllowlist).toHaveBeenCalledWith("group-1");
    expect(executeNative).toHaveBeenCalledOnce();
  });

  it("loads a service skill of the turn without the group's skill list", async () => {
    const executeNative = vi.fn().mockResolvedValue({ loaded: true });
    const loadGroupSkillAllowlist = vi.fn().mockResolvedValue(new Set());
    const tool = createExternalGroupLoadSkillTool({ executeNative, loadGroupSkillAllowlist });

    // The turn's catalog holds a service skill only while its tool is granted; the native loader
    // refuses any skill the turn was not given.
    await expect(tool.execute({ skill: "group-reminders" }, context())).resolves.toEqual({ loaded: true });
    expect(loadGroupSkillAllowlist).not.toHaveBeenCalled();
  });

  it("denies a revoked grant, an unknown skill and a malformed name before delegation", async () => {
    const executeNative = vi.fn();
    const loadGroupSkillAllowlist = vi.fn().mockResolvedValue(new Set());
    const tool = createExternalGroupLoadSkillTool({ executeNative, loadGroupSkillAllowlist });

    await expect(tool.execute({ skill: "behavior-preferences" }, context())).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    await expect(tool.execute({ skill: "unknown" }, context())).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    await expect(tool.execute({ skill: "../behavior-preferences" }, context())).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    expect(executeNative).not.toHaveBeenCalled();
  });
});
