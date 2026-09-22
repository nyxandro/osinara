/**
 * Memory authorization boundary tests.
 *
 * Constructs covered:
 * - A refused scope is written to the log with the scopes involved and without memory content.
 */
import { describe, expect, it, vi } from "vitest";

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

  it("records the refused scope so a denied write can be found by its code", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(() => requireWritableScope(authorization, "personal")).toThrowError(
        /AGENT_MEMORY_SCOPE_DENIED/u,
      );

      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
        allowedScopes: ["family"],
        code: "AGENT_MEMORY_SCOPE_DENIED",
        requestedScope: "personal",
        role: "owner",
      });
    } finally { warn.mockRestore(); }
  });
});
