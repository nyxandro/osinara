/**
 * Telegram group removal tool tests.
 *
 * Constructs covered:
 * - `manage_telegram_group.remove`: requires private owner approval context.
 * - Group removal is scoped by the verified family and Telegram chat identifier.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { removeGroup } = vi.hoisted(() => ({ removeGroup: vi.fn() }));

vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: { registerGroup: vi.fn(), removeGroup },
}));

import manageTelegramGroup from "../tools/manage_telegram_group.js";

function context(chatType: "private" | "supergroup"): ToolContext {
  const caller = {
    attributes: {
      familyId: "family-1",
      memoryScopes: ["personal", "family"],
      role: "owner",
      telegramChatId: chatType === "private" ? "101" : "-1001",
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

describe("manage_telegram_group.remove", () => {
  beforeEach(() => {
    removeGroup.mockReset();
    removeGroup.mockResolvedValue({ groupId: "group-1" });
  });

  it("removes a same-family group after private owner approval", async () => {
    await expect(
      manageTelegramGroup.execute(
        { action: "remove", telegramChatId: "-1003567628736" },
        context("private"),
      ),
    ).resolves.toEqual({ deleted: true, telegramChatId: "-1003567628736" });
    expect(removeGroup).toHaveBeenCalledWith({
      familyId: "family-1",
      requestedBy: "owner-1",
      telegramChatId: "-1003567628736",
    });
  });

  it("rejects removal from a group chat", async () => {
    await expect(
      manageTelegramGroup.execute(
        { action: "remove", telegramChatId: "-1003567628736" },
        context("supergroup"),
      ),
    ).rejects.toThrowError(/AGENT_ACCESS_DENIED|AGENT_PRIVATE_CHAT_REQUIRED/);
    expect(removeGroup).not.toHaveBeenCalled();
  });
});
