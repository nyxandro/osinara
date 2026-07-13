/**
 * Telegram HITL authorization regression tests.
 *
 * Constructs covered:
 * - Owner and memory guards accept the durable verified initiator after approval.
 * - A present non-owner caller cannot inherit the initiator's owner role.
 */
import type { SessionContext } from "eve/context";
import { describe, expect, it } from "vitest";

import { requirePrivateTelegramOwner } from "./family-context.js";
import { requireMemoryAuthorization } from "./memory-context.js";

function context(input: {
  currentRole?: "member" | "owner";
  initiatorRole?: "member" | "owner";
}): SessionContext {
  const auth = (role: "member" | "owner" | undefined, principalId: string) =>
    role
      ? {
          attributes: {
            familyId: "family-1",
            memoryScopes: ["personal", "family"],
            role,
            telegramChatId: "101",
             telegramChatType: "private",
             telegramUserId: principalId,
          },
          authenticator: "telegram",
          principalId,
          principalType: "user" as const,
        }
      : null;

  return {
    session: {
      auth: {
        current: auth(input.currentRole, "current-user"),
        initiator: auth(input.initiatorRole, "initiator-user"),
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as SessionContext;
}

describe("HITL authorization", () => {
  it("authorizes the private owner and memory scope after approval resumes", () => {
    const ctx = context({ initiatorRole: "owner" });

    expect(requirePrivateTelegramOwner(ctx)).toMatchObject({
      role: "owner",
      telegramChatId: "101",
      userId: "initiator-user",
    });
    expect(requireMemoryAuthorization(ctx)).toMatchObject({
      familyId: "family-1",
      scopes: ["personal", "family"],
      userId: "initiator-user",
    });
  });

  it("rejects a current member even when the initiator was an owner", () => {
    const ctx = context({ currentRole: "member", initiatorRole: "owner" });

    expect(() => requirePrivateTelegramOwner(ctx)).toThrowError(/AGENT_OWNER_REQUIRED/);
  });
});
