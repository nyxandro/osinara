/**
 * Telegram group skill policy PostgreSQL integration tests.
 *
 * Constructs covered:
 * - A current owner atomically replaces the exact family's group allowlist.
 * - Revoked ownership and another family's chat fail closed without mutation.
 * - A skill that is neither built in nor the family's working one is refused; the database
 *   constraint rejects malformed stored names.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function fixture(suffix: string) {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Skill family ${suffix}`],
  );
  const owner = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, $2) RETURNING id",
    [`skill-owner-${suffix}`, `Owner ${suffix}`],
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
     VALUES ($1, $2, $3, 'external', 'addressed_only', '{}')
     RETURNING id`,
    [family.rows[0]!.id, `-100${suffix}`, `Group ${suffix}`],
  );
  return {
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
    ownerId: owner.rows[0]!.id,
    telegramChatId: `-100${suffix}`,
  };
}

describeWithDatabase("Telegram group skill policy repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_groups, family_memberships, users, families CASCADE");
  });
  afterAll(closeDatabase);

  it("replaces and revokes the complete allowlist", async () => {
    const current = await fixture("4401");

    await expect(telegramGroupAdministrationRepository.updateSkills({
      familyId: current.familyId,
      requestedBy: current.ownerId,
      skillAllowlist: ["pohuy"],
      telegramChatId: current.telegramChatId,
    })).resolves.toEqual({ groupId: current.groupId, skillsNeedBash: false });
    await expect(database().query<{ skill_allowlist: string[] }>(
      "SELECT skill_allowlist FROM telegram_groups WHERE id = $1",
      [current.groupId],
    )).resolves.toMatchObject({ rows: [{ skill_allowlist: ["pohuy"] }] });

    await telegramGroupAdministrationRepository.updateSkills({
      familyId: current.familyId,
      requestedBy: current.ownerId,
      skillAllowlist: [],
      telegramChatId: current.telegramChatId,
    });
    const revoked = await database().query<{ skill_allowlist: string[] }>(
      "SELECT skill_allowlist FROM telegram_groups WHERE id = $1",
      [current.groupId],
    );
    expect(revoked.rows[0]?.skill_allowlist).toEqual([]);
  });

  it("rejects stale ownership and another family's group", async () => {
    const current = await fixture("4402");
    const other = await fixture("4403");
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [current.familyId, current.ownerId],
    );

    await expect(telegramGroupAdministrationRepository.updateSkills({
      familyId: current.familyId,
      requestedBy: current.ownerId,
      skillAllowlist: ["pohuy"],
      telegramChatId: current.telegramChatId,
    })).rejects.toThrowError(/AGENT_OWNER_REQUIRED/u);
    await expect(telegramGroupAdministrationRepository.updateSkills({
      familyId: other.familyId,
      requestedBy: other.ownerId,
      skillAllowlist: ["pohuy"],
      telegramChatId: current.telegramChatId,
    })).rejects.toThrowError(/AGENT_GROUP_NOT_FOUND/u);
  });

  it("rejects an uninstalled skill at the application boundary and malformed stored names", async () => {
    const current = await fixture("4404");
    await expect(telegramGroupAdministrationRepository.updateSkills({
      familyId: current.familyId, requestedBy: current.ownerId,
      skillAllowlist: ["unknown"], telegramChatId: current.telegramChatId,
    })).rejects.toThrow("AGENT_GROUP_SKILL_UNKNOWN");
    await expect(telegramGroupAdministrationRepository.updateSkills({
      familyId: current.familyId, requestedBy: current.ownerId,
      skillAllowlist: ["../escape"], telegramChatId: current.telegramChatId,
    })).rejects.toThrow("AGENT_GROUP_POLICY_INVALID");
    await expect(database().query(
      "UPDATE telegram_groups SET skill_allowlist = ARRAY['../escape'] WHERE id = $1",
      [current.groupId],
    )).rejects.toThrow();
  });

  it("saves browser prerequisites once and removes dependent skills when Bash is revoked", async () => {
    const current = await fixture("4405");
    await telegramGroupAdministrationRepository.updateSkills({
      familyId: current.familyId, requestedBy: current.ownerId,
      skillAllowlist: ["agent-browser", "pohuy"], telegramChatId: current.telegramChatId,
    });
    expect((await database().query("SELECT tool_allowlist,skill_allowlist FROM telegram_groups WHERE id=$1", [current.groupId])).rows)
      .toEqual([{ tool_allowlist: ["bash"], skill_allowlist: ["agent-browser", "pohuy"] }]);
    await telegramGroupAdministrationRepository.updatePolicy({
      familyId: current.familyId, requestedBy: current.ownerId, telegramChatId: current.telegramChatId,
      messageMode: "all", toolAllowlist: ["remember"],
    });
    expect((await database().query("SELECT tool_allowlist,skill_allowlist FROM telegram_groups WHERE id=$1", [current.groupId])).rows)
      .toEqual([{ tool_allowlist: ["remember"], skill_allowlist: ["pohuy"] }]);
  });
});
