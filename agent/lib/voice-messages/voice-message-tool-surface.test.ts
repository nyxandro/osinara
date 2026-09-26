/**
 * Voice message tool-surface tests.
 *
 * Constructs covered:
 * - Interactive private and family roots always receive the voice tool.
 * - An external group receives it only through an owner grant, rechecked live at execution.
 * - Scheduled turns and subagents never receive the billable, chat-facing tool.
 * - The owner can grant the capability, and the group prompt lists it only when it is emitted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());

vi.mock("../tool-policy/external-group-live-policy.js", () => ({
  authorizeCurrentExternalGroupCapability,
  loadCurrentExternalGroupCapabilities,
}));

import { externalGroupCapabilityInstructions } from "../tool-policy/external-group-capability-instructions.js";
import { GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES } from "../tool-policy/grantable-group-capabilities.js";
import { buildModeToolSurface, buildSubagentToolSurface } from "../tool-policy/mode-tool-surface.js";

const GRANTED = new Set(["send_voice_message"] as const);

function externalAuth() {
  return {
    current: {
      attributes: {
        familyId: "family-1",
        groupId: "group-1",
        groupType: "external",
        toolAllowlist: ["send_voice_message"],
      },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    },
    initiator: null,
  };
}

describe("voice message tool surface", () => {
  beforeEach(() => {
    loadCurrentExternalGroupCapabilities.mockReset();
    authorizeCurrentExternalGroupCapability.mockReset();
    authorizeCurrentExternalGroupCapability.mockImplementation(async () => {
      throw new Error("AGENT_GROUP_TOOL_FORBIDDEN");
    });
  });

  it("exposes the voice tool only to interactive roots", () => {
    for (const environment of ["private", "family"] as const) {
      expect(buildModeToolSurface({ environment })).toHaveProperty("send_voice_message");
      expect(buildModeToolSurface({ environment, scheduledRun: true }))
        .not.toHaveProperty("send_voice_message");
      expect(buildSubagentToolSurface({ environment })).not.toHaveProperty("send_voice_message");
    }
    expect(buildModeToolSurface({ capabilities: new Set(), environment: "external", skills: {} }))
      .not.toHaveProperty("send_voice_message");
    expect(buildModeToolSurface({ capabilities: GRANTED, environment: "external", skills: {} }))
      .toHaveProperty("send_voice_message");
    expect(buildModeToolSurface({
      capabilities: GRANTED,
      environment: "external",
      scheduledRun: true,
      skills: {},
    })).not.toHaveProperty("send_voice_message");
    expect(buildSubagentToolSurface({ capabilities: GRANTED, environment: "external", skills: {} }))
      .not.toHaveProperty("send_voice_message");
  });

  it("denies an external call after live capability revocation", async () => {
    const surface = buildModeToolSurface({ capabilities: GRANTED, environment: "external", skills: {} });
    const context = { session: { auth: externalAuth() } } as never;

    await expect(surface.send_voice_message!.execute({ text: "Привет" }, context))
      .rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
    expect(authorizeCurrentExternalGroupCapability).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "group-1" }),
      "send_voice_message",
    );
  });

  it("does not expose a workspace scope as model input", () => {
    const schema = buildModeToolSurface({ capabilities: GRANTED, environment: "external", skills: {} })
      .send_voice_message!.inputSchema as z.ZodType;

    expect(schema.safeParse({ text: "Привет" }).success).toBe(true);
    expect(schema.safeParse({ scope: "group", text: "Привет" }).success).toBe(false);
  });

  it("lets the owner grant the capability and lists it only in interactive group turns", () => {
    expect(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES).toContain("send_voice_message");
    const interactive = externalGroupCapabilityInstructions(GRANTED, new Set(), {
      includeApplicationCore: true,
      scheduledHistory: false,
      scheduledRun: false,
    });
    const scheduled = externalGroupCapabilityInstructions(GRANTED, new Set(), {
      includeApplicationCore: true,
      scheduledHistory: false,
      scheduledRun: true,
    });

    expect(interactive).toContain("`send_voice_message`");
    expect(scheduled).not.toContain("send_voice_message");
  });
});
