/**
 * Conversation environment resolution tests.
 *
 * Constructs covered:
 * - `resolveConversationEnvironment`: selects a trust zone from current verified auth only.
 * - Contradictory scopes and durable initiator metadata fail closed.
 *
 * Prompt composition for each trust zone is covered by `prompt/mode-instructions.test.ts`.
 */
import type { SessionAuth, SessionAuthContext } from "../runtime/context.js";
import { describe, expect, it } from "vitest";

import { resolveConversationEnvironment } from "./conversation-environment.js";

function caller(attributes: SessionAuthContext["attributes"]): SessionAuthContext {
  return {
    attributes: {
      telegramActorId: "101",
      telegramActorKind: "telegram_user",
      telegramUserId: "101",
      ...attributes,
    },
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

  it("selects the external profile for the registered external group type", () => {
    expect(resolveConversationEnvironment(auth({
      groupType: "external",
      memoryScopes: ["group"],
      telegramChatType: "group",
    }))).toBe("external");
  });

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
