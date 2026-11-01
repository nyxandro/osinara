/**
 * Image-capability gating for a model without image input.
 *
 * Constructs covered:
 * - No conversation surface offers image inspection, an external group included: seeing images is
 *   baseline access there, and without a model that sees images there is nothing to offer.
 * - Prompt guidance never names the absent tool, including the PDF page route and the import result.
 * - An external photo is still taken in: what participants send reaches the agent whatever the
 *   model, and the file can still be imported and processed otherwise.
 * - A grant persisted under the former per-group image right parses and is neither offered nor
 *   reported as something to fix.
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
import { GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES } from "./tool-policy/grantable-group-capabilities.js";
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
    });

    expect(buildModeToolSurface({ environment: "private" })).not.toHaveProperty("inspect_workspace_image");
    expect(buildModeToolSurface({ environment: "family" })).not.toHaveProperty("inspect_workspace_image");
    expect(external).not.toHaveProperty("inspect_workspace_image");
    expect(external).toHaveProperty("remember");
    // Attachments stay baseline access: a file can be imported and processed without vision.
    expect(buildModeToolSurface({ capabilities: new Set(), environment: "external" })).toHaveProperty("import_telegram_attachment");
  });

  it("drops image guidance from every mode prompt", () => {
    for (const instructions of [
      modeInstructions({ environment: "private" }),
      modeInstructions({ environment: "family" }),
      modeInstructions({ capabilities: new Set(), environment: "external" }),
    ]) {
      expect(instructions).not.toContain("inspect_workspace_image");
    }
    expect(importTelegramAttachment.description).not.toContain("inspect_workspace_image");
  });

  it("offers no image grant and refuses one sent anyway", async () => {
    const refused = {
      action: "update_policy",
      messageMode: "owner_only",
      telegramChatId: "-1001234567890",
      toolAllowlist: ["remember", "inspect_workspace_image"],
    };

    expect(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES).not.toContain("inspect_workspace_image");
    expect(JSON.stringify(manageTelegramGroup.inputSchema)).not.toContain("inspect_workspace_image");
    await expect(manageTelegramGroup.execute(refused as never, ownerContext())).rejects.toMatchObject({
      contract: { code: "AGENT_TELEGRAM_GROUP_INPUT_INVALID" },
    });
  });

  it("neither offers nor reports a persisted image grant", async () => {
    const status = await manageTelegramGroup.execute(
      { action: "status" },
      ownerContext(),
    ) as { groups: Array<Record<string, unknown>> };

    // The model round-trips `toolAllowlist` into update_policy, so it must stay grantable.
    expect(status.groups[0]).toMatchObject({ toolAllowlist: ["remember"] });
    expect(status.groups[0]).not.toHaveProperty("unavailableConfiguredTools");
  });

  it("takes in an external photo and records it with its attachment", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });

    await createTelegramMessageHandler(repository)(telegramContext().context, addressedExternalPhoto());

    expect(repository.journal.record).toHaveBeenCalledOnce();
    expect(repository.session.prepareTurn).toHaveBeenCalledOnce();
  });

  it("lets a scheduled automation keep image inspection without a group grant", () => {
    expect(requireGrantedExternalScheduleCapabilities(new Set(["inspect_workspace_image"]), new Set()))
      .toEqual(["inspect_workspace_image"]);
    expect(requireGrantedExternalScheduleCapabilities(new Set(["search_memories"]), new Set(["search_memories"])))
      .toEqual(["search_memories"]);
  });
});
