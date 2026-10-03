/**
 * External Telegram group policy projection tests.
 *
 * Constructs covered:
 * - `resolveExternalGroupToolPolicy`: derives policy only from verified Eve auth attributes.
 * - A resumed external session keeps its initiator policy and fails closed on any conflict.
 */
import type { SessionAuth } from "../../runtime/context.js";
import { describe, expect, it } from "vitest";

import { resolveExternalGroupToolPolicy } from "./external-group-policy.js";

function externalAuth(toolAllowlist: readonly string[], role = "external"): SessionAuth {
  return {
    current: {
      attributes: {
        familyId: "family-1",
        groupId: "group-1",
        groupType: "external",
        role,
        toolAllowlist,
      },
      authenticator: "telegram",
      principalId: "telegram:101",
      principalType: "user",
    },
    initiator: null,
  };
}

describe("external group tool policy", () => {
  it("does not restrict a non-external session", () => {
    expect(resolveExternalGroupToolPolicy({ current: null, initiator: null })).toEqual({
      restricted: false,
    });
  });

  it("uses the current external policy and accepts an explicit empty deny-all list", () => {
    expect(resolveExternalGroupToolPolicy(externalAuth([]))).toEqual({
      allowed: new Set(),
      restricted: true,
    });
    expect(resolveExternalGroupToolPolicy(externalAuth(["remember"]))).toEqual({
      allowed: new Set(["remember"]),
      restricted: true,
    });
  });

  it("fails closed when an external auth snapshot contains an invalid policy", () => {
    const auth = externalAuth(["unknown_tool"]);

    expect(resolveExternalGroupToolPolicy(auth)).toEqual({
      allowed: new Set(),
      restricted: true,
    });
  });

  it("retains the verified external initiator policy when HITL resumes without current auth", () => {
    const initial = externalAuth(["manage_memory.delete"]);

    expect(
      resolveExternalGroupToolPolicy({ current: null, initiator: initial.current }),
    ).toEqual({
      allowed: new Set(["manage_memory.delete"]),
      restricted: true,
    });
  });

  it("fails closed when an external initiator resumes with conflicting current auth", () => {
    const initial = externalAuth(["web_fetch"]);
    const current = {
      ...initial.current!,
      attributes: {
        familyId: "family-1",
        role: "owner",
      },
    };

    expect(resolveExternalGroupToolPolicy({ current, initiator: initial.current })).toEqual({
      allowed: new Set(),
      restricted: true,
    });
  });

  it("keeps a family owner restricted by the external group allowlist", () => {
    const ownerInExternalGroup = externalAuth(["remember"], "owner");

    expect(resolveExternalGroupToolPolicy(ownerInExternalGroup)).toEqual({
      allowed: new Set(["remember"]),
      restricted: true,
    });
  });
});
