/**
 * Conversation environment resolution tests.
 *
 * Constructs covered:
 * - `resolveConversationEnvironment`: selects a trust-zone profile from current verified auth.
 * - Contradictory scopes and durable initiator metadata fail closed.
 */
import type { SessionAuth, SessionAuthContext } from "eve/context";
import { describe, expect, it } from "vitest";

import { resolveConversationEnvironment } from "./conversation-environment.js";

function caller(attributes: SessionAuthContext["attributes"]): SessionAuthContext {
  return {
    attributes,
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user",
  };
}

function auth(attributes: SessionAuthContext["attributes"]): SessionAuth {
  return { current: caller(attributes), initiator: null };
}

describe("resolveConversationEnvironment", () => {
  it("selects the private profile only for personal and family scopes", () => {
    expect(resolveConversationEnvironment(auth({
      memoryScopes: ["personal", "family"],
      telegramChatType: "private",
    }))).toBe("private");
  });

  it("selects the family profile only for a registered family group", () => {
    expect(resolveConversationEnvironment(auth({
      groupType: "family_private",
      memoryScopes: ["family"],
      telegramChatType: "supergroup",
    }))).toBe("family");
  });

  it.each(["external_private", "external_public"])(
    "selects the external profile for %s",
    (groupType) => {
      expect(resolveConversationEnvironment(auth({
        groupType,
        memoryScopes: ["group"],
        telegramChatType: "group",
      }))).toBe("external");
    },
  );

  it("rejects contradictory chat type, group type, and memory scopes", () => {
    expect(() => resolveConversationEnvironment(auth({
      groupType: "family_private",
      memoryScopes: ["personal", "family"],
      telegramChatType: "supergroup",
    }))).toThrowError(/AGENT_CONVERSATION_ENVIRONMENT_INVALID/);
  });

  it("does not reuse a durable initiator when current auth is absent", () => {
    const initiator = caller({
      memoryScopes: ["personal", "family"],
      telegramChatType: "private",
    });

    expect(() => resolveConversationEnvironment({ current: null, initiator }))
      .toThrowError(/AGENT_CONVERSATION_ENVIRONMENT_INVALID/);
  });
});
