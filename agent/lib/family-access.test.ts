/**
 * Family access policy tests.
 *
 * Constructs covered:
 * - `resolveConversationAccess`: derives trusted memory and tool scopes.
 * - Family group membership boundary.
 * - External group isolation boundary.
 */
import { describe, expect, it } from "vitest";

import { resolveConversationAccess } from "./family-access.js";

describe("resolveConversationAccess", () => {
  it("allows a family member to use personal and family memory in a private chat", () => {
    const access = resolveConversationAccess({
      chat: { id: "101", type: "private" },
      identity: { familyId: "family-1", role: "member", userId: "user-1" },
      registeredGroup: null,
    });

    expect(access).toEqual({
      familyId: "family-1",
      groupId: null,
      memoryScopes: ["personal", "family"],
      role: "member",
      userId: "user-1",
    });
  });

  it("allows only family memory in a family group", () => {
    const access = resolveConversationAccess({
      chat: { id: "-1001", type: "supergroup" },
      identity: { familyId: "family-1", role: "member", userId: "user-1" },
      registeredGroup: {
        familyId: "family-1",
        groupId: "group-1",
        messageMode: "addressed_only",
        telegramChatId: "-1001",
        toolAllowlist: [],
        type: "family_private",
      },
    });

    expect(access.memoryScopes).toEqual(["family"]);
    expect(access.groupId).toBe("group-1");
  });

  it("rejects a non-family caller in a family group", () => {
    expect(() =>
      resolveConversationAccess({
        chat: { id: "-1001", type: "group" },
        identity: null,
        registeredGroup: {
          familyId: "family-1",
          groupId: "group-1",
          messageMode: "addressed_only",
          telegramChatId: "-1001",
          toolAllowlist: [],
          type: "family_private",
        },
      }),
    ).toThrowError(/AGENT_ACCESS_DENIED/);
  });

  it("isolates an external group from personal and family memory", () => {
    const access = resolveConversationAccess({
      chat: { id: "-2001", type: "group" },
      identity: null,
      registeredGroup: {
        familyId: "family-1",
        groupId: "group-2",
        messageMode: "all",
        telegramChatId: "-2001",
        toolAllowlist: ["remember"],
        type: "external_public",
      },
    });

    expect(access).toEqual({
      familyId: "family-1",
      groupId: "group-2",
      memoryScopes: ["group"],
      role: "external",
      userId: null,
    });
  });

  it("rejects an unregistered group before model execution", () => {
    expect(() =>
      resolveConversationAccess({
        chat: { id: "-3001", type: "group" },
        identity: null,
        registeredGroup: null,
      }),
    ).toThrowError(/AGENT_GROUP_NOT_REGISTERED/);
  });
});
