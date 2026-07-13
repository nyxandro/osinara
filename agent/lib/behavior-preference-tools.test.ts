/**
 * Behavior preference tool authorization tests.
 *
 * Constructs covered:
 * - `manage_behavior_preference.reset`: permits personal reset and owner-only shared reset.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deletePreference } = vi.hoisted(() => ({ deletePreference: vi.fn() }));

vi.mock("./behavior-preference-repository.js", () => ({
  behaviorPreferenceRepository: { delete: deletePreference },
}));

import manageBehaviorPreference from "../tools/manage_behavior_preference.js";

function createContext(role: "member" | "owner"): ToolContext {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            familyId: "family-1",
            groupId: "group-1",
            memoryScopes: ["personal", "family", "group"],
            role,
            telegramUserId: "telegram-user-1",
          },
          principalId: "user-1",
          principalType: "user",
        },
      },
      id: "session-1",
      turn: { id: "turn-1" },
    },
  } as unknown as ToolContext;
}

describe("behavior preference tools", () => {
  beforeEach(() => {
    deletePreference.mockReset();
    deletePreference.mockResolvedValue(true);
  });

  it("allows a member to reset a personal preference", async () => {
    await expect(
      manageBehaviorPreference.execute(
        { action: "reset", preference: "tone", scope: "personal" },
        createContext("member"),
      ),
    ).resolves.toEqual({ deleted: true });
    expect(deletePreference).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "personal",
      "tone",
    );
  });

  it("requires the owner to reset a shared preference", async () => {
    await expect(
      manageBehaviorPreference.execute(
        { action: "reset", preference: "tone", scope: "family" },
        createContext("member"),
      ),
    ).rejects.toThrowError(/AGENT_OWNER_REQUIRED/);
    expect(deletePreference).not.toHaveBeenCalled();

    await expect(
      manageBehaviorPreference.execute(
        { action: "reset", preference: "tone", scope: "group" },
        createContext("owner"),
      ),
    ).resolves.toEqual({ deleted: true });
  });
});
