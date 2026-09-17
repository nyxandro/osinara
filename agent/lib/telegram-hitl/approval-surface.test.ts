/**
 * Approval-surface denial tests.
 *
 * Constructs covered:
 * - `groupApprovalDenial`: a tool needing confirmation is denied in a group turn, not in a private one.
 * - The denial keeps a stable code the model can relay to the chat.
 */
import { describe, expect, it } from "vitest";

import { groupApprovalDenial } from "./approval-surface.js";

function session(attributes: Record<string, unknown>) {
  return {
    session: {
      auth: { current: { attributes, authenticator: "telegram", principalId: "user-1", principalType: "user" } },
    },
  } as never;
}

describe("groupApprovalDenial", () => {
  it("allows a confirmation in a private chat", () => {
    expect(groupApprovalDenial(session({
      telegramChatId: "101",
      telegramChatType: "private",
      telegramUserId: "101",
    }))).toBeNull();
  });

  it.each(["family_private", "external"])("denies a confirmation in a %s group turn", (groupType) => {
    const denial = groupApprovalDenial(session({
      groupId: "group-1",
      groupType,
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramUserId: "101",
    }));

    expect(denial?.type).toBe("denied");
    expect(denial?.reason).toContain("AGENT_APPROVAL_SURFACE_UNAVAILABLE");
  });

  it("leaves the decision to the channel boundary when the turn names no group", () => {
    expect(groupApprovalDenial(session({ telegramUserId: "101" }))).toBeNull();
  });
});
