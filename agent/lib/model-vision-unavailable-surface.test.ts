/**
 * Image-capability gating for a model without image input.
 *
 * Constructs covered:
 * - Trusted modes omit image inspection rather than exposing a guaranteed refusal.
 * - An external grant persisted under a vision model yields no descriptor, prompt guidance, photo
 *   intake or execution right, and the owner-facing grant contract drops the capability.
 * - Prompt guidance never names the absent tool, including the PDF page route and the import result.
 */
import type { ToolContext } from "../runtime/tool.js";
import { describe, expect, it, vi } from "vitest";

// The premise is stated rather than inherited from the checked-in provider config, so switching the
// repository default cannot silently turn this suite into an assertion about the opposite runtime.
vi.mock("./model-vision-availability.js", () => ({
  MODEL_VISION_AVAILABLE: false,
}));
vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: {
    listStatuses: vi.fn().mockResolvedValue([{
      messageMode: "owner_only",
      skillAllowlist: [],
      telegramChatId: "-1001234567890",
      title: "Внешняя группа",
      toolAllowlist: ["remember", "inspect_workspace_image"],
      type: "external",
    }]),
    registerGroup: vi.fn(),
    removeRegistration: vi.fn(),
    requestGroupSessionRotation: vi.fn(),
    updatePolicy: vi.fn(),
    updateSkills: vi.fn(),
  },
}));
vi.mock("./family-skills/family-skill-repository.js", () => ({
  familySkillRepository: { grantableSkills: vi.fn().mockResolvedValue(new Map()) },
}));
const databaseQuery = vi.hoisted(() => vi.fn());
vi.mock("./database.js", () => ({
  database: () => ({
    connect: async () => ({ query: databaseQuery, release: () => undefined }),
    query: databaseQuery,
  }),
}));

import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { requireGrantedExternalScheduleCapabilities } from "./agent-schedules/external-agent-schedule-policy.js";
import { modeInstructions } from "./prompt/mode-instructions.js";
import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";
import {
  GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES,
  servableExternalGroupCapabilities,
} from "./tool-policy/grantable-group-capabilities.js";
import {
  authorizeCurrentExternalGroupCapability,
  loadCurrentExternalGroupCapabilities,
} from "./tool-policy/external-group-live-policy.js";
import { buildModeToolSurface } from "./tool-policy/mode-tool-surface.js";
import importTelegramAttachment from "./tools/import_telegram_attachment.js";
import manageTelegramGroup from "./tools/manage_telegram_group.js";

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

function addressedExternalPhoto(): TelegramMessage {
  return {
    ...groupMessage(`@${BOT_USERNAME} что на фото?`),
    attachments: [{
      fileId: "telegram-photo-1",
      fileUniqueId: "telegram-photo-unique-1",
      kind: "photo",
      mediaType: "image/jpeg",
      size: 1_024,
    }],
    messageId: "42",
    raw: {
      date: 1_700_000_000,
      photo: [{
        file_id: "telegram-photo-1",
        file_unique_id: "telegram-photo-unique-1",
        height: 640,
        width: 640,
      }],
    },
  };
}

describe("a model without image input", () => {
  it("omits image inspection from every conversation surface", () => {
    const external = buildModeToolSurface({
      capabilities: new Set(["inspect_workspace_image", "remember"]),
      environment: "external",
      skills: new Set(),
    });

    expect(buildModeToolSurface({ environment: "private" })).not.toHaveProperty("inspect_workspace_image");
    expect(buildModeToolSurface({ environment: "family" })).not.toHaveProperty("inspect_workspace_image");
    expect(external).not.toHaveProperty("inspect_workspace_image");
    expect(external).toHaveProperty("remember");
  });

  it("drops image guidance from every mode prompt", () => {
    for (const instructions of [
      modeInstructions({ environment: "private" }),
      modeInstructions({ environment: "family" }),
      modeInstructions({ capabilities: new Set(["inspect_workspace_image"]), environment: "external" }),
    ]) {
      expect(instructions).not.toContain("inspect_workspace_image");
    }
    expect(importTelegramAttachment.description).not.toContain("inspect_workspace_image");
  });

  it("keeps a persisted image grant from widening the effective capability set", () => {
    expect(servableExternalGroupCapabilities(new Set(["inspect_workspace_image", "remember"])))
      .toEqual(new Set(["remember"]));
  });

  it("removes the capability from the grant contract and explains a refused grant", () => {
    const approval = manageTelegramGroup.approval;
    if (typeof approval !== "function") {
      throw new Error("AGENT_TEST_APPROVAL_CONTRACT_INVALID: manage_telegram_group approval is not callable");
    }

    expect(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES).not.toContain("inspect_workspace_image");
    expect(JSON.stringify(manageTelegramGroup.inputSchema)).not.toContain("inspect_workspace_image");
    expect(() => approval({
      toolInput: {
        action: "update_policy",
        messageMode: "owner_only",
        telegramChatId: "-1001234567890",
        toolAllowlist: ["remember", "inspect_workspace_image"],
      },
    } as never)).toThrowError(/AGENT_TELEGRAM_GROUP_INPUT_INVALID.*не видит изображения/su);
  });

  it("reports a grant persisted under a vision model as inert", async () => {
    const status = await manageTelegramGroup.execute(
      { action: "status" },
      ownerContext(),
    ) as { groups: Array<Record<string, unknown>> };

    // The model round-trips `toolAllowlist` into update_policy, so it must stay grantable.
    expect(status.groups[0]).toMatchObject({
      toolAllowlist: ["remember"],
      unavailableConfiguredTools: ["inspect_workspace_image"],
    });
  });

  it("does not take in an external photo that nothing could examine", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: ["inspect_workspace_image"],
      type: "external",
    });

    await expect(createTelegramMessageHandler(repository)(
      telegramContext().context,
      addressedExternalPhoto(),
    )).resolves.toBeNull();

    expect(repository.journal.record).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("gives a persisted image grant no live capability and no execution right", async () => {
    databaseQuery.mockImplementation(async (sql: string) => sql.includes("tool_allowlist")
      ? { rows: [{ tool_allowlist: ["inspect_workspace_image", "remember"] }] }
      : { rows: [] });
    const identity = { familyId: "family-1", groupId: "group-1" };

    await expect(loadCurrentExternalGroupCapabilities(identity)).resolves.toEqual(new Set(["remember"]));
    await expect(authorizeCurrentExternalGroupCapability(identity, "inspect_workspace_image"))
      .rejects.toMatchObject({ code: "AGENT_GROUP_TOOL_FORBIDDEN" });
    await expect(authorizeCurrentExternalGroupCapability(identity, "remember")).resolves.toBeUndefined();
  });

  it("refuses to put image inspection into a scheduled automation and says why", () => {
    expect(() => requireGrantedExternalScheduleCapabilities(
      new Set(["inspect_workspace_image"]),
      new Set(["inspect_workspace_image"]),
    )).toThrowError(/AGENT_EXTERNAL_SCHEDULE_CAPABILITY_UNAVAILABLE.*не видит изображения/su);
    expect(requireGrantedExternalScheduleCapabilities(new Set(["search_memories"]), new Set(["search_memories"])))
      .toEqual(["search_memories"]);
  });
});
