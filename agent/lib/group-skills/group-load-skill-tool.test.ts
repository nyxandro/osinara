/**
 * Execution-time external-group skill authorization tests.
 *
 * Constructs covered:
 * - The Eve loader runs only for a safe skill present in the current live group policy.
 * - Revoked, unknown and malformed requests fail before native skill loading.
 * - The capability-coupled `imagegen` skill additionally requires its active model provider.
 */
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

// The imagegen cases below describe the Codex-subscription runtime; the direct-provider denial has
// its own suite because the provider gate resolves once at module load.
vi.mock("../image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));

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
    const loadGroupSkillAllowlist = vi.fn().mockResolvedValue(new Set(["pohuy"]));
    const authorizeImageGeneration = vi.fn();
    const tool = createExternalGroupLoadSkillTool({
      authorizeImageGeneration,
      executeNative,
      loadGroupSkillAllowlist,
    });

    await expect(tool.execute({ skill: "pohuy" }, context())).resolves.toEqual({ loaded: true });
    expect(loadGroupSkillAllowlist).toHaveBeenCalledWith("group-1");
    expect(executeNative).toHaveBeenCalledOnce();
    expect(authorizeImageGeneration).not.toHaveBeenCalled();
  });

  it("loads imagegen only after the live generate_image capability check", async () => {
    const authorizeImageGeneration = vi.fn().mockResolvedValue(undefined);
    const executeNative = vi.fn().mockResolvedValue({ loaded: true });
    const loadGroupSkillAllowlist = vi.fn();
    const tool = createExternalGroupLoadSkillTool({
      authorizeImageGeneration,
      executeNative,
      loadGroupSkillAllowlist,
    });

    await expect(tool.execute({ skill: "imagegen" }, context())).resolves.toEqual({ loaded: true });
    expect(authorizeImageGeneration).toHaveBeenCalledWith(expect.anything());
    expect(loadGroupSkillAllowlist).not.toHaveBeenCalled();
  });

  it("does not load imagegen when the live capability check rejects", async () => {
    const authorizeImageGeneration = vi.fn().mockRejectedValue(
      new Error("AGENT_GROUP_TOOL_FORBIDDEN"),
    );
    const executeNative = vi.fn();
    const tool = createExternalGroupLoadSkillTool({
      authorizeImageGeneration,
      executeNative,
      loadGroupSkillAllowlist: vi.fn(),
    });

    await expect(tool.execute({ skill: "imagegen" }, context()))
      .rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
    expect(executeNative).not.toHaveBeenCalled();
  });

  it("denies a revoked grant and an unknown skill before delegation", async () => {
    const executeNative = vi.fn();
    const loadGroupSkillAllowlist = vi.fn().mockResolvedValue(new Set());
    const tool = createExternalGroupLoadSkillTool({
      authorizeImageGeneration: vi.fn(),
      executeNative,
      loadGroupSkillAllowlist,
    });

    await expect(tool.execute({ skill: "pohuy" }, context())).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    await expect(tool.execute({ skill: "unknown" }, context())).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    expect(executeNative).not.toHaveBeenCalled();
  });
});
