/**
 * Dynamic T-Invest skill boundary tests.
 *
 * Constructs covered:
 * - Personal/family-only skill publication from current verified auth.
 * - Scope-bound persistent HOME instructions and packaged CLI files.
 * - Removal of runtime self-update and implicit token persistence instructions.
 */
import type { SessionAuthContext } from "eve/context";
import { describe, expect, it } from "vitest";

import tInvestSkill, { T_INVEST_SCOPE_POLICY } from "../../skills/t-invest.js";

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
  return await tInvestSkill.events["turn.started"]?.({}, context(attributes));
}

describe("dynamic T-Invest skill", () => {
  it("declares the reusable personal/family scope flag", () => {
    expect(T_INVEST_SCOPE_POLICY.allowedScopes).toEqual(["personal", "family"]);
  });

  it("retains routing terms for portfolio, income, and ticker requests", async () => {
    const skill = await resolveSkill({
      familyId: "family-1",
      role: "owner",
      telegramChatType: "private",
    });

    expect(skill?.description).toContain("Т-Инвестиции");
    expect(skill?.description).toContain("portfolio");
    expect(skill?.description).toContain("dividends");
    expect(skill?.description).toContain("SBER");
  });

  it("publishes a personal package whose state remains under the current HOME", async () => {
    const skill = await resolveSkill({
      familyId: "family-1",
      role: "owner",
      telegramChatType: "private",
    });

    expect(skill).toMatchObject({
      description: expect.any(String),
      files: {
        "references/json-fields.md": expect.any(String),
        "scripts/tinvest.cjs": expect.any(String),
      },
    });
    expect(skill?.markdown).toContain("scope: personal");
    expect(skill?.markdown).toContain("$HOME/.config/tinvest/.env");
    expect(skill?.markdown).toContain("правами `0600`");
    expect(skill?.markdown).toContain("только по явной просьбе");
  });

  it("publishes the same package with family-only runtime storage in a family group", async () => {
    const skill = await resolveSkill({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "family_private",
      role: "member",
      telegramChatType: "supergroup",
    });

    expect(skill?.markdown).toContain("scope: family");
    expect(skill?.markdown).toContain("за пределами текущего `$HOME`");
  });

  it.each(["external_private", "external_public"] as const)(
    "does not publish the skill in an %s group",
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

  it("does not advertise runtime installation or update commands", async () => {
    const skill = await resolveSkill({
      familyId: "family-1",
      role: "owner",
      telegramChatType: "private",
    });

    expect(skill?.markdown).not.toContain("install.sh");
    expect(skill?.markdown).not.toContain("updateAvailable");
    expect(skill?.markdown).not.toContain("curl -fsSL");
    const cli = skill?.files?.["scripts/tinvest.cjs"];
    expect(cli).toBeTypeOf("string");
    expect(cli).not.toContain("raw.githubusercontent.com/nyxandro/t-invest-skill");
    expect(cli).not.toContain("checkForUpdate");
  });
});
