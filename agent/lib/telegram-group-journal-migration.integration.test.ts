/**
 * Telegram group journal migration integration test.
 *
 * Constructs covered:
 * - `003_telegram_group_journal.sql`: migrates Sicily by stable chat ID to `all`.
 * - Every other pre-existing group becomes `addressed_only` before NOT NULL enforcement.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const TEST_SCHEMA = "telegram_journal_migration_test";

describeWithDatabase("003 Telegram group journal migration", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("assigns explicit modes to all existing groups", async () => {
    const initialSql = await readFile(resolve("migrations/001_initial.sql"), "utf8");
    const journalSql = await readFile(resolve("migrations/003_telegram_group_journal.sql"), "utf8");
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(initialSql);
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Тестовая семья') RETURNING id",
      );
      await client.query(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type)
         VALUES ($1, '-1003567628736', 'Переименованная Сицилия', 'family_private'),
                ($1, '-1009999999999', 'Другая группа', 'external_private')`,
        [family.rows[0]!.id],
      );

      await client.query(journalSql);

      const groups = await client.query<{ message_mode: string; telegram_chat_id: string }>(
        "SELECT telegram_chat_id, message_mode::text FROM telegram_groups ORDER BY telegram_chat_id",
      );
      expect(groups.rows).toEqual([
        { message_mode: "all", telegram_chat_id: "-1003567628736" },
        { message_mode: "addressed_only", telegram_chat_id: "-1009999999999" },
      ]);
      const nullable = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'telegram_groups' AND column_name = 'message_mode'`,
        [TEST_SCHEMA],
      );
      expect(nullable.rows[0]?.is_nullable).toBe("NO");
    } finally {
      client.release();
    }
  });
});
