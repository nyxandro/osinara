/**
 * Telegram external-group policy update tool tests.
 *
 * Constructs covered:
 * - `manage_telegram_group.update_policy`: requires one complete top-level policy payload.
 * - Execution uses only verified private-owner identity and returns the persisted policy contract.
 * - Subscription-coupled capabilities are grantable only while their model provider is active.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updatePolicy } = vi.hoisted(() => ({ updatePolicy: vi.fn() }));

// This suite covers the Codex-subscription runtime, where image generation is genuinely grantable.
// The direct-provider denial has its own suite because the gate resolves once at module load.
vi.mock("./image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));
vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: {
    registerGroup: vi.fn(),
    removeRegistration: vi.fn(),
    updatePolicy,
  },
}));

import manageTelegramGroup from "./tools/manage_telegram_group.js";

function context(chatType: "private" | "supergroup", role: "member" | "owner" = "owner"): ToolContext {
  const caller = {
    attributes: {
      familyId: "family-1",
      memoryScopes: ["personal", "family"],
      role,
      telegramChatId: chatType === "private" ? "101" : "-1001234567890",
      telegramChatType: chatType,
    },
    authenticator: "telegram",
    principalId: role === "owner" ? "owner-1" : "member-1",
    principalType: "user" as const,
  };
  return {
    session: {
      auth: { current: caller, initiator: caller },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as ToolContext;
}

const input = {
  action: "update_policy" as const,
  messageMode: "owner_only" as const,
  telegramChatId: "-1003567628736",
  toolAllowlist: ["remember", "list_group_history", "generate_image"] as Array<
    "remember" | "list_group_history" | "generate_image"
  >,
};

describe("manage_telegram_group.update_policy", () => {
  beforeEach(() => {
    updatePolicy.mockReset();
    updatePolicy.mockResolvedValue({ groupId: "group-1" });
  });

  it("updates one complete policy after private-owner approval resumes", async () => {
    await expect(manageTelegramGroup.execute(input, context("private"))).resolves.toEqual({
      botMembership: "unchanged",
      groupId: "group-1",
      messageMode: "owner_only",
      policyUpdated: true,
      telegramChatId: "-1003567628736",
      toolAllowlist: ["remember", "list_group_history", "generate_image"],
    });
    expect(updatePolicy).toHaveBeenCalledWith({
      familyId: "family-1",
      messageMode: "owner_only",
      requestedBy: "owner-1",
      telegramChatId: "-1003567628736",
      toolAllowlist: ["remember", "list_group_history", "generate_image"],
    });
  });

  it("describes a complete in-place replacement without type or title", () => {
    expect(manageTelegramGroup.description).toContain(
      "ровно action, telegramChatId, messageMode и полный toolAllowlist",
    );
    expect(manageTelegramGroup.description).toContain("type и title не передавай");
    expect(manageTelegramGroup.description).toContain(
      "сначала вызови status и перенеси неизменённые текущие права",
    );
    expect(manageTelegramGroup.description).toContain("полный toolAllowlist");
    expect(manageTelegramGroup.description).toContain(
      "добавь или удали только выбранную capability",
    );
    expect(manageTelegramGroup.description).toContain("сохраняет её ID, название, тип, историю, workspace, память и сессии");
  });

  it("ignores known sibling fields materialized beside the complete policy", async () => {
    await expect(manageTelegramGroup.execute({
      ...input,
      registration: {},
      skillAllowlist: ["pohuy"],
    }, context("private"))).resolves.toMatchObject({ policyUpdated: true });
    expect(updatePolicy).toHaveBeenCalledWith(expect.objectContaining({
      messageMode: "owner_only",
      toolAllowlist: ["remember", "list_group_history", "generate_image"],
    }));
  });

  it.each([
    { action: "update_policy", messageMode: "all", telegramChatId: "-1003567628736" },
    { action: "update_policy", telegramChatId: "-1003567628736", toolAllowlist: [] },
    { action: "update_policy", messageMode: "all", toolAllowlist: [] },
    { ...input, title: "Новое название" },
    { ...input, type: "external" },
    { ...input, telegramChatId: -1003567628736 },
  ])("rejects an incomplete or extended policy payload", async (invalidInput) => {
    await expect(manageTelegramGroup.execute(invalidInput as never, context("private"))).rejects.toThrowError(
      /AGENT_TELEGRAM_GROUP_INPUT_INVALID/,
    );
    expect(updatePolicy).not.toHaveBeenCalled();
  });

  it.each([
    context("supergroup"),
    context("private", "member"),
  ])("rejects execution outside the current owner's private chat", async (invalidContext) => {
    await expect(manageTelegramGroup.execute(input, invalidContext)).rejects.toThrowError(
      /AGENT_ACCESS_DENIED|AGENT_OWNER_REQUIRED|AGENT_PRIVATE_CHAT_REQUIRED/,
    );
    expect(updatePolicy).not.toHaveBeenCalled();
  });
});
