/**
 * Subscription image generation tool-surface tests.
 *
 * Constructs covered:
 * - Interactive roots receive image generation only when their runtime/provider policy permits it.
 * - Scheduled turns and subagents never receive the billable tool.
 * - External execution rechecks the live owner-managed capability before provider access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());

vi.mock("./image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));
vi.mock("../tool-policy/external-group-live-policy.js", () => ({
  authorizeCurrentExternalGroupCapability,
  loadCurrentExternalGroupCapabilities,
}));

import {
  buildModeToolSurface,
  buildSubagentToolSurface,
} from "../tool-policy/mode-tool-surface.js";

function externalAuth() {
  return {
    current: {
      attributes: {
        familyId: "family-1",
        groupId: "group-1",
        groupType: "external",
        toolAllowlist: ["generate_image"],
      },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    },
    initiator: null,
  };
}

describe("image generation tool surface", () => {
  beforeEach(() => {
    loadCurrentExternalGroupCapabilities.mockReset();
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set());
    authorizeCurrentExternalGroupCapability.mockReset();
    authorizeCurrentExternalGroupCapability.mockImplementation(async () => {
      throw new Error("AGENT_GROUP_TOOL_FORBIDDEN");
    });
  });

  it("exposes generation only to interactive roots", () => {
    const deniedExternal = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
      skills: { imagegen: {} as never },
    });

    expect(buildModeToolSurface({ environment: "private" })).toHaveProperty("generate_image");
    expect(buildSubagentToolSurface({ environment: "private" })).not.toHaveProperty("generate_image");
    expect(buildModeToolSurface({ environment: "private", scheduledRun: true }))
      .not.toHaveProperty("generate_image");
    expect(buildModeToolSurface({
      capabilities: new Set(["generate_image"]),
      environment: "external",
      skills: {},
    })).toHaveProperty("generate_image");
    expect(buildModeToolSurface({
      capabilities: new Set(["generate_image"]),
      environment: "external",
      scheduledRun: true,
      skills: { imagegen: {} as never },
    })).not.toHaveProperty("generate_image");
    expect(buildSubagentToolSurface({
      capabilities: new Set(["generate_image"]),
      environment: "external",
      skills: { imagegen: {} as never },
    }).load_skill?.description).toMatch(/недоступен/iu);
    expect(deniedExternal).not.toHaveProperty("generate_image");
    expect(deniedExternal.load_skill?.description).toMatch(/недоступен/iu);
  });

  it("denies an external call after live capability revocation", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["generate_image"]),
      environment: "external",
      skills: {},
    });
    const context = { session: { auth: externalAuth() } } as never;

    await expect(surface.generate_image!.execute({}, context))
      .rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
    expect(surface.generate_image!.description).not.toMatch(/[—–«»]/u);
  });
});
