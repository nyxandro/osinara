/**
 * Google Workspace authorization context tests.
 *
 * Constructs covered:
 * - `requireGoogleWorkspaceAuthorization`: accepts only a current verified private Telegram member.
 * - Group callers and stale initiator-only approval state fail closed.
 */
import { describe, expect, it } from "vitest";

import { requireGoogleWorkspaceAuthorization } from "./google-workspace-context.js";

function context(chatType: "group" | "private", current = true) {
  const caller = {
    attributes: {
      familyId: "00000000-0000-4000-8000-000000000001",
      role: "member",
      telegramChatId: "101",
      telegramChatType: chatType,
    },
    authenticator: "telegram",
    principalId: "00000000-0000-4000-8000-000000000002",
    principalType: "user",
  };
  return {
    session: {
      auth: current ? { current: caller } : { current: null, initiator: caller },
    },
  } as never;
}

describe("Google Workspace authorization context", () => {
  it("derives the account owner only from the current private Telegram caller", () => {
    expect(requireGoogleWorkspaceAuthorization(context("private"))).toEqual({
      familyId: "00000000-0000-4000-8000-000000000001",
      role: "member",
      telegramChatId: "101",
      userId: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("rejects group and initiator-only contexts", () => {
    expect(() => requireGoogleWorkspaceAuthorization(context("group"))).toThrowError(
      /AGENT_GOOGLE_WORKSPACE_PRIVATE_ONLY/,
    );
    expect(() => requireGoogleWorkspaceAuthorization(context("private", false))).toThrowError(
      /AGENT_GOOGLE_WORKSPACE_CONTEXT_INVALID/,
    );
  });
});
