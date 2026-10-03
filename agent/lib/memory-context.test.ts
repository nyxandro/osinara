/**
 * Memory authorization boundary tests.
 *
 * Constructs covered:
 * - A scope the chat does not carry is refused; the refusal is logged by the `remember` boundary.
 */
import { describe, expect, it } from "vitest";

import { requireWritableScope, type MemoryAuthorization } from "./memory-context.js";

const authorization: MemoryAuthorization = {
  familyId: "family-1",
  groupId: null,
  role: "owner",
  scopes: ["family"],
  telegramActorId: "101",
  telegramActorKind: "telegram_user",
  telegramUserId: "101",
  userId: "user-1",
};

describe("requireWritableScope", () => {
  it("returns the requested scope when the chat carries it", () => {
    expect(requireWritableScope(authorization, "family")).toBe("family");
  });

  it("refuses a scope the chat does not carry", () => {
    expect(() => requireWritableScope(authorization, "personal")).toThrowError(
      /AGENT_MEMORY_SCOPE_DENIED/u,
    );
  });
});
