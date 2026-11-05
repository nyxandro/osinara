/**
 * Telegram group removal tool tests.
 *
 * Constructs covered:
 * - `manage_telegram_group.remove`: requires private owner approval context.
 * - Group removal is scoped by the verified family and Telegram chat identifier, and goes through the
 *   removal that also deletes the chat's raw copies and confirms to the owner (#464).
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { removeRegistration } = vi.hoisted(() => ({ removeRegistration: vi.fn() }));

vi.mock("./group-connection/group-connection-actions.js", () => ({
  groupConnectionActions: { disconnect: vi.fn(), reconnect: vi.fn(), remove: removeRegistration },
}));

import manageTelegramGroup from "./tools/manage_telegram_group.js";

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
    removeRegistration.mockReset();
    removeRegistration.mockResolvedValue({ ownerNotified: true, status: "removed", telegramChatId: "-1003567628736", title: "Семья" });
  });

  it("removes a same-family group after private owner approval", async () => {
    await expect(
      manageTelegramGroup.execute(
        { action: "remove", telegramChatId: "-1003567628736" },
        context("private"),
      ),
    ).resolves.toEqual({ ownerNotified: true, status: "removed", telegramChatId: "-1003567628736", title: "Семья" });
    expect(removeRegistration).toHaveBeenCalledWith({
      familyId: "family-1",
      ownerTelegramChatId: "101",
      requestedBy: "owner-1",
      telegramChatId: "-1003567628736",
    });
  });

  it("ignores known sibling fields materialized beside the removal target", async () => {
    await expect(manageTelegramGroup.execute({
      action: "remove",
      messageMode: "all",
      registration: {},
      skillAllowlist: ["behavior-preferences"],
      telegramChatId: "-1003567628736",
      toolAllowlist: ["remember"],
    }, context("private"))).resolves.toMatchObject({ status: "removed" });
    expect(removeRegistration).toHaveBeenCalledWith(expect.objectContaining({
      telegramChatId: "-1003567628736",
    }));
  });

  it("rejects removal from a group chat", async () => {
    await expect(
      manageTelegramGroup.execute(
        { action: "remove", telegramChatId: "-1003567628736" },
        context("supergroup"),
      ),
    ).rejects.toThrowError(/AGENT_ACCESS_DENIED|AGENT_PRIVATE_CHAT_REQUIRED/);
    expect(removeRegistration).not.toHaveBeenCalled();
  });

  it("does not support an independent Telegram leave action", async () => {
    await expect(
      manageTelegramGroup.execute(
        { action: "leave", telegramChatId: "-1003567628736" } as never,
        context("private"),
      ),
    ).rejects.toThrowError(/AGENT_TELEGRAM_GROUP_INPUT_INVALID/);
    expect(removeRegistration).not.toHaveBeenCalled();
  });
});
