/**
 * Telegram group status PostgreSQL integration tests.
 *
 * Constructs covered:
 * - Current owners can list complete persisted policies for only their family.
 * - Revoked owners fail closed before group configuration is returned.
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

async function familyFixture(suffix: string) {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Status ${suffix}`],
  );
  const owner = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, $2) RETURNING id",
    [`status-owner-${suffix}`, `Owner ${suffix}`],
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, ownerId: owner.rows[0]!.id };
}

describeWithDatabase("Telegram group status repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_groups, family_memberships, users, families CASCADE");
  });
  afterAll(closeDatabase);

  it("lists all and only current-family registrations with complete policy fields", async () => {
    const current = await familyFixture("current");
    const other = await familyFixture("other");
    await database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist, skill_allowlist)
       VALUES
         ($1, '-1002', 'Внешняя', 'external', 'owner_only', ARRAY['search_memories'], ARRAY['behavior-preferences']),
         ($1, '-1001', 'Семья', 'family_private', 'all', '{}', '{}'),
         ($2, '-1003', 'Чужая', 'external', 'addressed_only', ARRAY['remember'], '{}')`,
      [current.familyId, other.familyId],
    );

    await expect(telegramGroupAdministrationRepository.listStatuses({
      familyId: current.familyId,
      requestedBy: current.ownerId,
    })).resolves.toEqual([
      {
        messageMode: "owner_only",
        skillAllowlist: ["behavior-preferences"],
        telegramChatId: "-1002",
        title: "Внешняя",
        toolAllowlist: ["search_memories"],
        type: "external",
      },
      {
        messageMode: "all",
        skillAllowlist: [],
        telegramChatId: "-1001",
        title: "Семья",
        toolAllowlist: [],
        type: "family_private",
      },
    ]);
  });

  it("rejects a stale owner snapshot", async () => {
    const current = await familyFixture("revoked");
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [current.familyId, current.ownerId],
    );

    await expect(telegramGroupAdministrationRepository.listStatuses({
      familyId: current.familyId,
      requestedBy: current.ownerId,
    })).rejects.toThrowError(/AGENT_OWNER_REQUIRED/);
  });
});
