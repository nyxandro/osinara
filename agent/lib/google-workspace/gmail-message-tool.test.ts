/**
 * Structured Gmail message mutation tool tests.
 *
 * Constructs covered:
 * - Every supported message-state action runs at once in a live turn, without a person's
 *   confirmation; a scenario run is refused, since nobody is there to see it.
 * - The backend, not the model, compiles one exact batch gws argv.
 * - Only the published action/messageIds/profileRef contract reaches execution, bounded to one batch.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { requireGmailMessageInput } from "./gmail-message-contract.js";
import { classifyGoogleWorkspaceCommand } from "./google-workspace-command-policy.js";
import manageGmailMessage, {
  createGmailMessageManager,
} from "../tools/manage_gmail_message.js";

const PRIVATE_ATTRIBUTES = { telegramChatId: "101", telegramChatType: "private", telegramUserId: "101" };
const FAMILY_GROUP_ATTRIBUTES = {
  groupId: "group-1", groupType: "family_private",
  telegramChatId: "-1001", telegramChatType: "supergroup", telegramUserId: "101",
};
const INPUT = { action: "trash", messageIds: ["18f"], profileRef: "gws_personal" };

function turnWith(attributes: Record<string, string>, kind = "conversation") {
  return {
    session: {
      auth: {
        current: { attributes, authenticator: "telegram", principalId: "user-1", principalType: "user" },
        initiator: null,
      },
      turn: { id: "turn-1", kind, sequence: 1 },
    },
  } as never;
}

function approvalFor(input: Record<string, unknown>, turn: never) {
  return (manageGmailMessage as unknown as {
    approval: (context: { session: unknown; toolInput: Record<string, unknown> }) => unknown;
  }).approval({ session: (turn as { session: unknown }).session, toolInput: input });
}

describe("manage_gmail_message", () => {
  it("changes messages without waiting for a person's confirmation in a live turn", () => {
    for (const attributes of [PRIVATE_ATTRIBUTES, FAMILY_GROUP_ATTRIBUTES]) {
      expect(approvalFor(INPUT, turnWith(attributes))).toBe("not-applicable");
    }
  });

  it.each([
    ["an isolated scenario run", { scheduledRunId: "00000000-0000-4000-8000-000000000010" }],
    ["a scenario wake-up in the conversation", { conversationScheduleRunId: "00000000-0000-4000-8000-000000000011" }],
    ["a wake-up continued after a button press", { telegramApprovalContinuation: "true" }],
  ])("refuses a change in %s, before and at execution", async (_name, scenario) => {
    const turn = turnWith({ ...PRIVATE_ATTRIBUTES, ...scenario }, "scheduledRunId" in scenario ? "scheduled" : "wakeup");
    expect(approvalFor(INPUT, turn)).toMatchObject({
      reason: expect.stringContaining("AGENT_GOOGLE_WORKSPACE_SCENARIO_WRITE_FORBIDDEN"),
      type: "denied",
    });
    await expect((manageGmailMessage as unknown as {
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    }).execute(INPUT, turn)).rejects.toMatchObject({ code: "AGENT_GOOGLE_WORKSPACE_SCENARIO_WRITE_FORBIDDEN" });
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
      // The backend-compiled command must pass the same policy the executor re-applies.
      expect(classifyGoogleWorkspaceCommand(argv)).toBe("mutation");
    },
  );

  it("accepts a full batch of long Gmail IDs: no confirmation card bounds the command size", () => {
    const messageIds = Array.from({ length: 30 }, (_, index) => `${"m".repeat(500)}${index}`);

    expect(requireGmailMessageInput({ action: "delete", messageIds, profileRef: "profile-1" }).messageIds)
      .toEqual(messageIds);
  });

  it.each([
    ["an empty batch", []],
    ["more than 30 messages", Array.from({ length: 31 }, (_, index) => `message-${index}`)],
    ["a repeated message", ["message-1", "message-2", "message-1"]],
  ])("rejects %s before execution", (_name, messageIds) => {
    expect(() => requireGmailMessageInput({ action: "trash", messageIds, profileRef: "profile-1" }))
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

  it("rejects control characters inside any messageId before execution", () => {
    expect(() => requireGmailMessageInput({
      action: "trash",
      messageIds: ["message-1", "message\nid"],
      profileRef: "profile-1",
    })).toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
  });

  it("rejects invisible format characters inside a messageId", () => {
    expect(() => requireGmailMessageInput({
      action: "trash",
      messageIds: ["message\u200Bid"],
      profileRef: "profile-1",
    })).toThrowError(/AGENT_GMAIL_MESSAGE_INPUT_INVALID/u);
  });
});
