/**
 * Dynamic skill scope policy tests.
 *
 * Constructs covered:
 * - `defineSkillScopePolicy`: explicit allowed-scope declaration for trusted skills.
 * - `resolveAllowedSkillScope`: fail-closed scope resolution from fresh verified auth.
 */
import type { SessionAuth, SessionAuthContext } from "eve/context";
import { describe, expect, it } from "vitest";

import {
  defineSkillScopePolicy,
  resolveAllowedSkillScope,
} from "./skill-scope-policy.js";

function caller(attributes: SessionAuthContext["attributes"]): SessionAuthContext {
  return {
    attributes,
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user",
  };
}

const trustedPolicy = defineSkillScopePolicy({
  allowedScopes: ["personal", "family"],
});

describe("dynamic skill scope policy", () => {
  it("resolves a private Telegram caller to personal scope", () => {
    const auth: SessionAuth = {
      current: caller({ familyId: "family-1", role: "member", telegramChatType: "private" }),
      initiator: null,
    };

    expect(resolveAllowedSkillScope(auth, trustedPolicy)).toBe("personal");
  });

  it("resolves only a verified family-private group to family scope", () => {
    const auth: SessionAuth = {
      current: caller({
        familyId: "family-1",
        groupId: "group-1",
        groupType: "family_private",
        role: "member",
        telegramChatType: "supergroup",
      }),
      initiator: null,
    };

    expect(resolveAllowedSkillScope(auth, trustedPolicy)).toBe("family");
  });

  it.each(["external_private", "external_public"] as const)(
    "rejects %s groups even when the caller is a family owner",
    (groupType) => {
      const auth: SessionAuth = {
        current: caller({
          familyId: "family-1",
          groupId: "group-1",
          groupType,
          role: "owner",
          telegramChatType: "supergroup",
        }),
        initiator: null,
      };

      expect(resolveAllowedSkillScope(auth, trustedPolicy)).toBeNull();
    },
  );

  it("does not reuse a durable initiator when current auth is absent", () => {
    const auth: SessionAuth = {
      current: null,
      initiator: caller({ familyId: "family-1", role: "owner", telegramChatType: "private" }),
    };

    expect(resolveAllowedSkillScope(auth, trustedPolicy)).toBeNull();
  });

  it("applies each skill's declared allowed-scope flag", () => {
    const familyAuth: SessionAuth = {
      current: caller({
        familyId: "family-1",
        groupId: "group-1",
        groupType: "family_private",
        role: "member",
        telegramChatType: "group",
      }),
      initiator: null,
    };
    const personalOnly = defineSkillScopePolicy({ allowedScopes: ["personal"] });

    expect(resolveAllowedSkillScope(familyAuth, personalOnly)).toBeNull();
  });
});
