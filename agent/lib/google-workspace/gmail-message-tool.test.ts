/**
 * Structured Gmail message mutation tool tests.
 *
 * Constructs covered:
 * - Every supported message-state action requires Eve HITL in a private chat.
 * - A group turn is refused as an ordinary tool denial, because no confirmation can be shown there.
 * - The backend, not the model, compiles one exact batch gws argv after approval.
 * - Only the published action/messageIds/profileRef contract reaches execution, bounded to one
 *   batch whose command still fits the approvable size the executor re-checks.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { classifyGoogleWorkspaceCommand } from "./google-workspace-command-policy.js";
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
      { action: "trash", messageIds: ["18f"], profileRef: "gws_personal" },
      FAMILY_GROUP_TURN,
    ) as { reason: string; type: string };

    expect(denial.type).toBe("denied");
    expect(denial.reason).toContain("AGENT_APPROVAL_SURFACE_UNAVAILABLE");
  });

  it("publishes one bounded batch of structured message-state actions", () => {
    const schema = z.toJSONSchema((manageGmailMessage as unknown as {
      inputSchema: Parameters<typeof z.toJSONSchema>[0];
    }).inputSchema) as { properties?: Record<string, unknown> };

    expect(schema.properties).toMatchObject({
      action: {
        enum: ["trash", "delete", "restore", "mark_read", "mark_unread"],
        type: "string",
      },
      messageIds: { items: { type: "string" }, maxItems: 30, minItems: 1, type: "array" },
      profileRef: { type: "string" },
    });
    expect(schema.properties).not.toHaveProperty("argv");
    expect(schema.properties).not.toHaveProperty("messageId");
    for (const action of ["trash", "delete", "restore", "mark_read", "mark_unread"]) {
      expect(approvalFor({ action, messageIds: ["message-1", "message-2"], profileRef: "profile-1" }))
        .toBe("user-approval");
    }
  });

  it.each([
    ["trash", "batchModify", { ids: ["18f1a", "18f1b"], addLabelIds: ["TRASH"] }],
    ["delete", "batchDelete", { ids: ["18f1a", "18f1b"] }],
    ["restore", "batchModify", { ids: ["18f1a", "18f1b"], removeLabelIds: ["TRASH"] }],
    ["mark_read", "batchModify", { ids: ["18f1a", "18f1b"], removeLabelIds: ["UNREAD"] }],
    ["mark_unread", "batchModify", { ids: ["18f1a", "18f1b"], addLabelIds: ["UNREAD"] }],
  ] as const)(
    "compiles action=%s for the whole batch into one exact %s command",
    async (action, method, body) => {
      const execute = vi.fn().mockResolvedValue({ completed: true });
      const manage = createGmailMessageManager({ execute });
      const ctx = { callId: "call-1" } as never;

      await expect(manage({
        action,
        messageIds: ["18f1a", "18f1b"],
        profileRef: "profile-1",
      }, ctx)).resolves.toEqual({
        completed: true,
      });
      expect(execute).toHaveBeenCalledOnce();
      const [{ argv, expectedProfileRef }] = execute.mock.calls[0]! as [{ argv: string[]; expectedProfileRef: string }];
      expect(expectedProfileRef).toBe("profile-1");
      expect(argv.slice(0, 6)).toEqual(["gmail", "users", "messages", method, "--params", '{"userId":"me"}']);
      expect(argv[6]).toBe("--json");
      expect(JSON.parse(argv[7]!)).toEqual(body);
      expect(argv).toHaveLength(8);
      // The backend-compiled command must pass the same policy the executor re-applies after approval.
      expect(classifyGoogleWorkspaceCommand(argv)).toBe("mutation");
    },
  );

  it("accepts a full batch of realistic Gmail IDs within the approvable command size", () => {
    const messageIds = Array.from({ length: 30 }, (_, index) => `${"a".repeat(62)}${String(index).padStart(2, "0")}`);

    expect(approvalFor({ action: "delete", messageIds, profileRef: "profile-1" })).toBe("user-approval");
  });

  it.each([
    ["an empty batch", []],
    ["more than 30 messages", Array.from({ length: 31 }, (_, index) => `message-${index}`)],
    ["a repeated message", ["message-1", "message-2", "message-1"]],
    ["a path segment instead of a message ID", ["message-1", ".."]],
    ["a current-directory segment", ["."]],
    ["a command too long to show before approval", Array.from({ length: 30 }, (_, index) => `${"m".repeat(500)}${index}`)],
  ])("rejects %s before metadata or execution", (_name, messageIds) => {
    expect(() => approvalFor({ action: "trash", messageIds, profileRef: "profile-1" }))
      .toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
  });

  it("rejects unpublished input before execution", async () => {
    const execute = vi.fn();
    const manage = createGmailMessageManager({ execute });

    for (const input of [
      { action: "trash", argv: ["gmail"], messageIds: ["message-1"], profileRef: "profile-1" },
      { action: "trash", messageId: "message-1", profileRef: "profile-1" },
    ]) {
      await expect(manage(input as never, {} as never)).rejects.toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects control characters inside any messageId before metadata or execution", () => {
    expect(() => approvalFor({
      action: "trash",
      messageIds: ["message-1", "message\nid"],
      profileRef: "profile-1",
    })).toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
  });

  it("rejects invisible format characters before preview can hide them", () => {
    expect(() => approvalFor({
      action: "trash",
      messageIds: ["message\u200Bid"],
      profileRef: "profile-1",
    })).toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
  });
});
