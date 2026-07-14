/**
 * Dynamic Google Workspace skill boundary tests.
 *
 * Constructs covered:
 * - Skill publication is limited to the current verified personal scope.
 * - Instructions expose structured gws usage without credential or shell handling.
 */
import type { SessionAuthContext } from "eve/context";
import { describe, expect, it } from "vitest";

import googleWorkspaceSkill, {
  GOOGLE_WORKSPACE_SCOPE_POLICY,
} from "../../skills/google-workspace.js";

function context(attributes: SessionAuthContext["attributes"]) {
  return {
    channel: { kind: "telegram" },
    messages: [],
    session: {
      auth: {
        current: {
          attributes,
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  };
}

async function resolveSkill(attributes: SessionAuthContext["attributes"]) {
  return await googleWorkspaceSkill.events["turn.started"]?.({}, context(attributes));
}

describe("dynamic Google Workspace skill", () => {
  it("publishes structured instructions only in the personal scope", async () => {
    expect(GOOGLE_WORKSPACE_SCOPE_POLICY.allowedScopes).toEqual(["personal"]);
    const skill = await resolveSkill({
      familyId: "family-1",
      role: "member",
      telegramChatType: "private",
    });

    expect(skill?.description).toContain("Google Workspace");
    expect(skill?.markdown).toContain("google_workspace");
    expect(skill?.markdown).toContain("resourcePath");
    expect(skill?.markdown).not.toContain("gws auth login");
  });

  it.each(["family_private", "external_private"] as const)(
    "does not publish in a %s group",
    async (groupType) => {
      const skill = await resolveSkill({
        familyId: "family-1",
        groupId: "group-1",
        groupType,
        role: "owner",
        telegramChatType: "supergroup",
      });

      expect(skill).toBeNull();
    },
  );
});
