/**
 * Structured Gmail message mutation tool tests.
 *
 * Constructs covered:
 * - Every supported message-state action requires Eve HITL in a private chat.
 * - A group turn is refused as an ordinary tool denial, because no confirmation can be shown there.
 * - The backend, not the model, compiles the exact gws argv after approval.
 * - Only the published action/messageId/profileRef contract reaches execution.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import manageGmailMessage, {
  createGmailMessageManager,
} from "../tools/manage_gmail_message.js";

const PRIVATE_TURN = {
  session: {
    auth: {
      current: {
        attributes: { telegramChatId: "101", telegramChatType: "private", telegramUserId: "101" },
        authenticator: "telegram",
        principalId: "user-1",
        principalType: "user",
      },
    },
  },
} as never;

const FAMILY_GROUP_TURN = {
  session: {
    auth: {
      current: {
        attributes: {
          groupId: "group-1", groupType: "family_private",
          telegramChatId: "-1001", telegramChatType: "supergroup", telegramUserId: "101",
        },
        authenticator: "telegram",
        principalId: "user-1",
        principalType: "user",
      },
    },
  },
} as never;

function approvalFor(input: Record<string, unknown>, turn: never = PRIVATE_TURN) {
  return (manageGmailMessage as unknown as {
    approval: (context: { session: unknown; toolInput: Record<string, unknown> }) => unknown;
  }).approval({ session: (turn as { session: unknown }).session, toolInput: input });
}

describe("manage_gmail_message", () => {
  it("denies a message mutation in a group turn instead of losing the turn to a refused prompt", () => {
    const denial = approvalFor(
      { action: "trash", messageId: "18f", profileRef: "gws_personal" },
      FAMILY_GROUP_TURN,
    ) as { reason: string; type: string };

    expect(denial.type).toBe("denied");
    expect(denial.reason).toContain("AGENT_APPROVAL_SURFACE_UNAVAILABLE");
  });

  it("publishes only structured message-state actions", () => {
    const schema = z.toJSONSchema((manageGmailMessage as unknown as {
      inputSchema: Parameters<typeof z.toJSONSchema>[0];
    }).inputSchema) as { properties?: Record<string, unknown> };

    expect(schema.properties).toMatchObject({
      action: {
        enum: ["trash", "delete", "restore", "mark_read", "mark_unread"],
        type: "string",
      },
      messageId: { type: "string" },
      profileRef: { type: "string" },
    });
    expect(schema.properties).not.toHaveProperty("argv");
    for (const action of ["trash", "delete", "restore", "mark_read", "mark_unread"]) {
      expect(approvalFor({ action, messageId: "message-1", profileRef: "profile-1" }))
        .toBe("user-approval");
    }
  });

  it.each([
    ["trash", ["gmail", "users", "messages", "trash", "--params", '{"userId":"me","id":"18f1a2b3c4d"}']],
    ["delete", ["gmail", "users", "messages", "delete", "--params", '{"userId":"me","id":"18f1a2b3c4d"}']],
    ["restore", ["gmail", "users", "messages", "untrash", "--params", '{"userId":"me","id":"18f1a2b3c4d"}']],
    ["mark_read", ["gmail", "users", "messages", "modify", "--params", '{"userId":"me","id":"18f1a2b3c4d"}', "--json", '{"removeLabelIds":["UNREAD"]}']],
    ["mark_unread", ["gmail", "users", "messages", "modify", "--params", '{"userId":"me","id":"18f1a2b3c4d"}', "--json", '{"addLabelIds":["UNREAD"]}']],
  ] as const)(
    "compiles action=%s into one exact backend command",
    async (action, argv) => {
      const execute = vi.fn().mockResolvedValue({ completed: true });
      const manage = createGmailMessageManager({ execute });
      const ctx = { callId: "call-1" } as never;

      await expect(manage({
        action,
        messageId: "18f1a2b3c4d",
        profileRef: "profile-1",
      }, ctx)).resolves.toEqual({
        completed: true,
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith({
        argv: [...argv],
        expectedProfileRef: "profile-1",
      }, ctx);
    },
  );

  it("rejects unpublished input before execution", async () => {
    const execute = vi.fn();
    const manage = createGmailMessageManager({ execute });

    await expect(manage({
      action: "trash",
      argv: ["gmail"],
      messageId: "message-1",
      profileRef: "profile-1",
    } as never, {} as never)).rejects.toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects control characters inside messageId before metadata or execution", () => {
    expect(() => approvalFor({
      action: "trash",
      messageId: "message\nid",
      profileRef: "profile-1",
    })).toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
  });

  it("rejects invisible format characters before preview can hide them", () => {
    expect(() => approvalFor({
      action: "trash",
      messageId: "message\u200Bid",
      profileRef: "profile-1",
    })).toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
  });
});
