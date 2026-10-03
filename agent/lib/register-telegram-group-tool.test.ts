/**
 * Telegram group registration tool tests.
 *
 * Constructs covered:
 * - `manage_telegram_group.register`: executes after private-owner HITL resume.
 * - A freshly authenticated group callback remains invalid for private-only administration.
 * - Owner-only dispatch can be assigned only to an external trust zone.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registerGroup } = vi.hoisted(() => ({ registerGroup: vi.fn() }));

vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: { registerGroup, removeRegistration: vi.fn() },
}));

import manageTelegramGroup from "./tools/manage_telegram_group.js";

function context(chatType: "private" | "supergroup"): ToolContext {
  const caller = {
    attributes: {
      familyId: "family-1",
      memoryScopes: ["personal", "family"],
      role: "owner",
      telegramChatId: chatType === "private" ? "101" : "-1001234567890",
      telegramChatType: chatType,
    },
    authenticator: "telegram",
    principalId: "owner-1",
    principalType: "user" as const,
  };
  return {
    session: {
      auth: {
        current: caller,
        initiator: caller,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as ToolContext;
}

const input = {
  messageMode: "all" as const,
  telegramChatId: "-1003567628736",
  title: "Сицилия",
  type: "family_private" as const,
};

describe("manage_telegram_group.register", () => {
  beforeEach(() => {
    registerGroup.mockReset();
    registerGroup.mockResolvedValue({ groupId: "group-1" });
  });

  it("persists the group after a private owner approval resumes", async () => {
    await expect(manageTelegramGroup.execute(
      { action: "register", registration: input },
      context("private"),
    )).resolves.toEqual({
      active: true,
      groupId: "group-1",
      messageMode: "all",
      telegramChatId: "-1003567628736",
      title: "Сицилия",
      toolAllowlist: [],
      type: "family_private",
    });
    expect(registerGroup).toHaveBeenCalledWith({
      ...input,
      familyId: "family-1",
      requestedBy: "owner-1",
      toolAllowlist: [],
    });
  });

  it("ignores known top-level fields materialized beside registration", async () => {
    await expect(manageTelegramGroup.execute({
      action: "register",
      messageMode: "owner_only",
      registration: input,
      skillAllowlist: ["pohuy"],
      telegramChatId: "-1009999999999",
      toolAllowlist: ["remember"],
    }, context("private"))).resolves.toMatchObject({
      telegramChatId: "-1003567628736",
      type: "family_private",
    });
    expect(registerGroup).toHaveBeenCalledWith(expect.objectContaining({
      telegramChatId: "-1003567628736",
      type: "family_private",
    }));
  });

  it("rejects registration approval from a group chat", async () => {
    await expect(manageTelegramGroup.execute(
      { action: "register", registration: input },
      context("supergroup"),
    )).rejects.toThrowError(
      /AGENT_PRIVATE_CHAT_REQUIRED/,
    );
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it("rejects an external allowlist change from a group chat", async () => {
    await expect(manageTelegramGroup.execute(
      {
        action: "register",
        registration: {
          ...input,
          toolAllowlist: ["remember"],
          type: "external",
        },
      },
      context("supergroup"),
    )).rejects.toThrowError(/AGENT_PRIVATE_CHAT_REQUIRED/);
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it("persists owner-only dispatch for an external group", async () => {
    await manageTelegramGroup.execute({
      action: "register",
      registration: {
        ...input,
        messageMode: "owner_only",
        toolAllowlist: ["list_group_history"],
        type: "external",
      },
    }, context("private"));

    expect(registerGroup).toHaveBeenCalledWith(expect.objectContaining({
      messageMode: "owner_only",
      toolAllowlist: ["list_group_history"],
      type: "external",
    }));
  });

  it("rejects owner-only dispatch for a family group", async () => {
    await expect(manageTelegramGroup.execute({
      action: "register",
      registration: { ...input, messageMode: "owner_only" },
    }, context("private"))).rejects.toThrowError(/AGENT_TELEGRAM_GROUP_INPUT_INVALID/);

    expect(registerGroup).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, telegramChatId: -1003567628736 },
    { ...input, title: "Рабочая группа\nTelegram chat ID: -100999" },
  ])("rejects ambiguous registration fields before persistence", async (registration) => {
    await expect(manageTelegramGroup.execute(
      { action: "register", registration } as never,
      context("private"),
    )).rejects.toThrowError(/AGENT_TELEGRAM_GROUP_INPUT_INVALID/);
    expect(registerGroup).not.toHaveBeenCalled();
  });
});
