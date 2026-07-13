/**
 * Telegram group registration tool tests.
 *
 * Constructs covered:
 * - `manage_telegram_group.register`: executes after private-owner HITL resume.
 * - Group-chat execution is rejected because Telegram callbacks do not identify the clicker.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registerGroup } = vi.hoisted(() => ({ registerGroup: vi.fn() }));

vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: { registerGroup, removeGroup: vi.fn() },
}));

import manageTelegramGroup from "../tools/manage_telegram_group.js";

function context(chatType: "private" | "supergroup"): ToolContext {
  return {
    session: {
      auth: {
        current: null,
        initiator: {
          attributes: {
            familyId: "family-1",
            memoryScopes: ["personal", "family"],
            role: "owner",
            telegramChatId: chatType === "private" ? "101" : "-1001234567890",
            telegramChatType: chatType,
          },
          authenticator: "telegram",
          principalId: "owner-1",
          principalType: "user",
        },
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
      type: "family_private",
    });
    expect(registerGroup).toHaveBeenCalledWith({
      ...input,
      familyId: "family-1",
      requestedBy: "owner-1",
      toolAllowlist: [],
    });
  });

  it("rejects registration approval from a group chat", async () => {
    await expect(manageTelegramGroup.execute(
      { action: "register", registration: input },
      context("supergroup"),
    )).rejects.toThrowError(
      /AGENT_ACCESS_DENIED/,
    );
    expect(registerGroup).not.toHaveBeenCalled();
  });
});
