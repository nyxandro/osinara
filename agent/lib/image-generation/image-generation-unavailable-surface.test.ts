/**
 * Direct-provider image generation denial tests.
 *
 * Constructs covered:
 * - A persisted group grant cannot advertise or execute subscription generation without CLIProxy.
 * - Trusted modes omit the tool rather than exposing a guaranteed configuration failure.
 * - The owner-facing grant contract drops the capability, so it cannot be enabled at all.
 * - Skill loading and tool execution fail closed before any durable or billable side effect.
 */
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

vi.mock("./image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: false,
}));
vi.mock("../telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: {
    listStatuses: vi.fn().mockResolvedValue([{
      messageMode: "owner_only",
      telegramChatId: "-1001234567890",
      title: "Внешняя группа",
      toolAllowlist: ["remember", "generate_image"],
      type: "external",
    }]),
    registerGroup: vi.fn(),
    removeRegistration: vi.fn(),
    requestGroupSessionRotation: vi.fn(),
    updatePolicy: vi.fn(),
    updateSkills: vi.fn(),
  },
}));

import { createExternalGroupLoadSkillTool } from "../group-skills/group-load-skill-tool.js";
import manageTelegramGroup from "../tools/manage_telegram_group.js";
import { createGenerateImageTool } from "../tools/generate_image.js";
import { externalGroupCapabilityInstructions } from "../tool-policy/external-group-capability-instructions.js";
import { GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES } from "../tool-policy/grantable-group-capabilities.js";
import { buildModeToolSurface } from "../tool-policy/mode-tool-surface.js";

const OWNER = {
  attributes: {
    familyId: "family-1",
    memoryScopes: ["personal", "family"],
    role: "owner",
    telegramChatId: "101",
    telegramChatType: "private",
  },
  authenticator: "telegram",
  principalId: "owner-1",
  principalType: "user" as const,
};

function ownerContext(): ToolContext {
  return {
    session: { auth: { current: OWNER, initiator: OWNER }, id: "session-1" },
  } as unknown as ToolContext;
}

function externalContext(): ToolContext {
  return {
    callId: "call-image-1",
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

describe("unavailable subscription image generation", () => {
  it("omits tool, skill loading, and prompt guidance", () => {
    const external = buildModeToolSurface({
      capabilities: new Set(["generate_image"]),
      environment: "external",
      skills: { imagegen: {} as never },
    });
    const instructions = externalGroupCapabilityInstructions(
      new Set(["generate_image"]),
      new Set(),
    );

    expect(buildModeToolSurface({ environment: "private" })).not.toHaveProperty("generate_image");
    expect(external).not.toHaveProperty("generate_image");
    expect(external.load_skill?.description).toMatch(/недоступен/iu);
    expect(instructions).not.toContain("generate_image");
    expect(instructions).not.toContain("skill=imagegen");
  });

  it("removes the capability from the owner-facing grant contract", () => {
    expect(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES).not.toContain("generate_image");
    // The descriptor the owner's model reads must not name a right it can never obtain.
    expect(JSON.stringify(manageTelegramGroup.inputSchema)).toContain("search_memories");
    expect(JSON.stringify(manageTelegramGroup.inputSchema)).not.toContain("generate_image");
  });

  it("refuses to grant the capability during registration and policy update", () => {
    const rejected = /AGENT_TELEGRAM_GROUP_INPUT_INVALID.*OpenAI Codex/su;

    expect(() => manageTelegramGroup.approval!({
      toolInput: {
        action: "update_policy",
        messageMode: "owner_only",
        telegramChatId: "-1001234567890",
        toolAllowlist: ["remember", "generate_image"],
      },
    } as never)).toThrowError(rejected);
    expect(() => manageTelegramGroup.approval!({
      toolInput: {
        action: "register",
        registration: {
          messageMode: "owner_only",
          telegramChatId: "-1001234567890",
          title: "Внешняя группа",
          toolAllowlist: ["generate_image"],
          type: "external",
        },
      },
    } as never)).toThrowError(rejected);
  });

  it("reports a grant persisted under the previous provider as inert", async () => {
    const status = await manageTelegramGroup.execute(
      { action: "status" },
      ownerContext(),
    ) as { groups: Array<Record<string, unknown>> };

    // The model round-trips `toolAllowlist` into update_policy, so it must stay grantable.
    expect(status.groups[0]).toMatchObject({
      toolAllowlist: ["remember"],
      unavailableConfiguredTools: ["generate_image"],
    });
    expect(status.groups[0]!.effectiveConfiguredTools).not.toContain("generate_image");
  });

  it("fails closed before loading the coupled skill", async () => {
    const authorizeImageGeneration = vi.fn();
    const executeNative = vi.fn();
    const tool = createExternalGroupLoadSkillTool({
      authorizeImageGeneration,
      executeNative,
      loadGroupSkillAllowlist: vi.fn(),
    });

    await expect(tool.execute({ skill: "imagegen" }, externalContext()))
      .rejects.toThrowError(/AGENT_GROUP_SKILL_FORBIDDEN/u);
    expect(authorizeImageGeneration).not.toHaveBeenCalled();
    expect(executeNative).not.toHaveBeenCalled();
  });

  it("fails a stale descriptor call before reserving a billable operation", async () => {
    const begin = vi.fn();
    const generate = vi.fn();
    const tool = createGenerateImageTool({
      client: { generate },
      deliver: vi.fn(),
      operations: {
        begin,
        complete: vi.fn(),
        markAmbiguous: vi.fn(),
        markFailed: vi.fn(),
      },
      workspaces: {
        findBinaryWrite: vi.fn(),
        workspaceId: vi.fn(),
        writeBinary: vi.fn(),
      },
    });

    await expect(tool.execute({
      background: "auto",
      prompt: "A clean editorial illustration",
      quality: "auto",
      scope: "group",
      size: "auto",
    }, externalContext())).rejects.toThrowError(/AGENT_IMAGE_GENERATION_UNAVAILABLE/u);
    expect(begin).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
