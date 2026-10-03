/** Group workspace authorization must not depend on whether a participant is a human or a bot. */
import type { SessionAuthContext, SessionContext } from "../../runtime/context.js";
import { describe, expect, it } from "vitest";

import { requireWorkspaceAuthorization } from "./workspace-context.js";

function context(actor: "telegram_user" | "telegram_bot" | "telegram_channel") {
  const id = actor === "telegram_channel" ? "-200" : "101";
  const current: SessionAuthContext = {
    authenticator: "telegram",
    principalId: actor === "telegram_user" ? "telegram:101"
      : actor === "telegram_bot" ? `telegram-bot:${id}` : `telegram-channel:${id}`,
    principalType: actor === "telegram_user" ? "user" : "service",
    attributes: {
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      role: "external",
      telegramActorId: id,
      telegramActorKind: actor,
      telegramChatType: "supergroup",
      ...(actor === "telegram_channel" ? {} : { telegramUserId: id }),
    },
  };
  return { session: { auth: { current, initiator: current } } } as Pick<SessionContext, "session">;
}

describe("requireWorkspaceAuthorization", () => {
  it.each(["telegram_user", "telegram_bot", "telegram_channel"] as const)(
    "gives %s the same group-only workspace",
    (actor) => {
      expect(requireWorkspaceAuthorization(context(actor))).toEqual({
        familyId: "family-1",
        groupId: "group-1",
        groupType: "external",
        role: "external",
        telegramChatType: "supergroup",
        userId: null,
      });
    },
  );

  it.each([
    { role: "owner" },
    { groupType: "family_private" },
    { telegramChatType: "private" },
    { groupId: null },
    { memoryScopes: ["group", "family"] },
    { telegramActorId: "different-bot" },
  ])("rejects a service participant with inconsistent authority: %j", (attributes) => {
    const ctx = context("telegram_bot");
    Object.assign(ctx.session.auth.current!.attributes, attributes);
    expect(() => requireWorkspaceAuthorization(ctx)).toThrow("AGENT_WORKSPACE_CONTEXT_INVALID");
  });

  it("does not accept an arbitrary service as a Telegram participant", () => {
    const ctx = context("telegram_bot");
    Object.assign(ctx.session.auth.current!, { principalId: "unrelated-service" });
    expect(() => requireWorkspaceAuthorization(ctx)).toThrow("AGENT_WORKSPACE_CONTEXT_INVALID");
  });
});
