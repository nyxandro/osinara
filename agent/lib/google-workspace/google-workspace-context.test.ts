/**
 * Google Workspace authorization context tests.
 *
 * Constructs covered:
 * - `requireGoogleWorkspaceConnectionActor`: selects personal or family scope from verified chat auth.
 * - External groups and stale initiator-only state fail closed.
 */
import { describe, expect, it } from "vitest";

import { requireGoogleWorkspaceConnectionActor } from "./google-workspace-context.js";

function context(input: {
  chatType: "private" | "supergroup";
  current?: boolean;
  groupType?: "external_private" | "family_private";
  role?: "member" | "owner";
}) {
  const caller = {
    attributes: {
      familyId: "00000000-0000-4000-8000-000000000001",
      ...(input.groupType ? { groupId: "00000000-0000-4000-8000-000000000004" } : {}),
      ...(input.groupType ? { groupType: input.groupType } : {}),
      role: input.role ?? "member",
      telegramChatId: "101",
      telegramChatType: input.chatType,
      telegramUserId: "202",
    },
    authenticator: "telegram",
    principalId: "00000000-0000-4000-8000-000000000002",
    principalType: "user",
  };
  return {
    session: {
      auth: input.current === false ? { current: null, initiator: caller } : { current: caller },
    },
  } as never;
}

describe("Google Workspace authorization context", () => {
  it("derives a personal profile from the current private Telegram caller", () => {
    expect(requireGoogleWorkspaceConnectionActor(context({ chatType: "private" }))).toEqual({
      familyId: "00000000-0000-4000-8000-000000000001",
      role: "member",
      scope: "personal",
      telegramUserId: "202",
      userId: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("derives a separate family profile in a registered family group", () => {
    expect(requireGoogleWorkspaceConnectionActor(context({
      chatType: "supergroup",
      groupType: "family_private",
      role: "owner",
    }))).toMatchObject({ role: "owner", scope: "family", telegramUserId: "202" });
  });

  it("rejects external groups and initiator-only contexts", () => {
    expect(() => requireGoogleWorkspaceConnectionActor(context({
      chatType: "supergroup",
      groupType: "external_private",
      role: "owner",
    }))).toThrowError(/AGENT_GOOGLE_WORKSPACE_CONTEXT_INVALID/);
    expect(() => requireGoogleWorkspaceConnectionActor(context({
      chatType: "private",
      current: false,
    }))).toThrowError(
      /AGENT_GOOGLE_WORKSPACE_CONTEXT_INVALID/,
    );
  });
});
