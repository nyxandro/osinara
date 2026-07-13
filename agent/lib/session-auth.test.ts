/**
 * Durable Eve session authentication tests.
 *
 * Constructs covered:
 * - `resolveSessionCaller`: trusts only the current turn identity.
 * - Durable initiator metadata never substitutes for a missing callback identity.
 */
import type { SessionAuth, SessionAuthContext } from "eve/context";
import { describe, expect, it } from "vitest";

import { resolveSessionCaller } from "./session-auth.js";

function caller(principalId: string, chatType: "private" | "supergroup" = "private"): SessionAuthContext {
  return {
    attributes: { familyId: "family-1", role: "owner", telegramChatType: chatType },
    authenticator: "telegram",
    principalId,
    principalType: "user",
  };
}

describe("resolveSessionCaller", () => {
  it("does not reuse a private durable initiator when current callback auth is absent", () => {
    const initiator = caller("owner-1");
    const auth: SessionAuth = { current: null, initiator };

    expect(resolveSessionCaller({ session: { auth } })).toBeNull();
  });

  it("never replaces a present current caller with a more privileged initiator", () => {
    const current = caller("member-1");
    const auth: SessionAuth = { current, initiator: caller("owner-1") };

    expect(resolveSessionCaller({ session: { auth } })).toBe(current);
  });

  it("returns null when neither verified identity exists", () => {
    const auth: SessionAuth = { current: null, initiator: null };

    expect(resolveSessionCaller({ session: { auth } })).toBeNull();
  });

  it("does not reuse initiator identity for a group callback with an unknown clicker", () => {
    const auth: SessionAuth = {
      current: null,
      initiator: caller("owner-1", "supergroup"),
    };

    expect(resolveSessionCaller({ session: { auth } })).toBeNull();
  });
});
