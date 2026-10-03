/**
 * External-group reminder authorization tests.
 *
 * Constructs covered:
 * - Exact group, chat and Telegram author projection from verified auth.
 * - Channel-authored turns fail with the author-unidentified contract.
 * - Trusted private and family contexts never resolve as a group reminder author.
 */
import type { ToolContext } from "../../runtime/tool.js";
import { describe, expect, it } from "vitest";

import { AppError } from "../app-error.js";
import { requireGroupReminderAuthorization } from "./group-reminder-context.js";

function context(
  attributes: Record<string, unknown>,
  principalType = "user",
  servicePrincipalId = "telegram-channel:-100500",
): ToolContext {
  return {
    session: {
      auth: {
        current: {
          attributes,
          authenticator: "telegram",
          principalId: principalType === "user" ? "telegram-user-77" : servicePrincipalId,
          principalType,
        },
      },
      id: "session-1",
      turn: { id: "turn-1" },
    },
  } as unknown as ToolContext;
}

const externalAttributes = {
  familyId: "family-1",
  groupId: "group-1",
  groupType: "external",
  memoryScopes: ["group"],
  role: "external",
  telegramActorId: "77",
  telegramActorKind: "telegram_user",
  telegramChatId: "-1001",
  telegramChatType: "supergroup",
  telegramUserId: "77",
};

describe("requireGroupReminderAuthorization", () => {
  it("projects the verified group destination and Telegram author", () => {
    expect(requireGroupReminderAuthorization(context(externalAttributes))).toEqual({
      familyId: "family-1",
      groupId: "group-1",
      telegramChatId: "-1001",
      telegramUserId: "77",
    });
  });

  it("carries no forum topic, because group delivery is chat-level by contract", () => {
    expect(requireGroupReminderAuthorization(context({
      ...externalAttributes,
      telegramForumTopicId: "12",
      telegramMessageThreadId: "12",
    }))).toEqual({
      familyId: "family-1",
      groupId: "group-1",
      telegramChatId: "-1001",
      telegramUserId: "77",
    });
  });

  it("lets another bot own a group reminder under its own Telegram id", () => {
    const botAttributes = {
      ...externalAttributes,
      telegramActorId: "8123456789",
      telegramActorKind: "telegram_bot",
      telegramUserId: "8123456789",
    };

    expect(requireGroupReminderAuthorization(
      context(botAttributes, "service", "telegram-bot:8123456789"),
    )).toMatchObject({
      groupId: "group-1",
      telegramChatId: "-1001",
      telegramUserId: "8123456789",
    });
  });

  it("refuses a channel-authored turn because no person can own the reminder", () => {
    const channelAttributes = {
      ...externalAttributes,
      telegramActorId: "-100500",
      telegramActorKind: "telegram_channel",
    };
    delete (channelAttributes as Record<string, unknown>).telegramUserId;

    try {
      requireGroupReminderAuthorization(context(channelAttributes, "service"));
      expect.unreachable("channel authorship must not resolve");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("AGENT_REMINDER_AUTHOR_UNIDENTIFIED");
      expect((error as AppError).message).toContain("от имени канала");
    }
  });

  it.each([
    ["private chat", {
      familyId: "family-1",
      memoryScopes: ["personal", "family"],
      role: "owner",
      telegramActorId: "77",
      telegramActorKind: "telegram_user",
      telegramChatId: "77",
      telegramChatType: "private",
      telegramUserId: "77",
    }],
    ["family group", {
      ...externalAttributes,
      groupType: "family_private",
      memoryScopes: ["family"],
      role: "member",
    }],
  ])("refuses a trusted %s context", (_case, attributes) => {
    expect(() => requireGroupReminderAuthorization(context(attributes)))
      .toThrow(AppError);
  });

  it("refuses an external turn without a registered group id", () => {
    const attributes = { ...externalAttributes };
    delete (attributes as Record<string, unknown>).groupId;

    expect(() => requireGroupReminderAuthorization(context(attributes))).toThrow(AppError);
  });
});
