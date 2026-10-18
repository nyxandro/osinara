/**
 * Removed built-in skills cleanup migration integration test.
 *
 * Constructs covered:
 * - `135_remove_t_invest_and_pohuy_skills.sql`: takes both removed names out of every persisted group
 *   skill list, keeps every other skill in its order, and leaves untouched lists as they were.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { GROUP_SAFE_SKILL_NAMES } from "./group-skill-catalog.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const TEST_SCHEMA = "removed_skills_cleanup_test";

describeWithDatabase("135 removed built-in skills cleanup", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("removes t-invest and pohuy from every group skill list and keeps the rest", async () => {
    const migrationSql = await readFile(resolve("migrations/135_remove_t_invest_and_pohuy_skills.sql"), "utf8");
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      // Three production external groups held pohuy among six other skills on 18.10.2026.
      await client.query(`
        CREATE TABLE telegram_groups (id integer PRIMARY KEY, skill_allowlist text[] NOT NULL);
        INSERT INTO telegram_groups (id, skill_allowlist) VALUES
          (1, ARRAY['agent-browser', 'pohuy', 'xlsx']),
          (2, ARRAY['t-invest', 'pdf', 'pohuy']),
          (3, ARRAY['docx']),
          (4, ARRAY[]::text[]);
      `);

      await client.query(migrationSql);

      const result = await client.query<{ id: number; skill_allowlist: string[] }>(
        "SELECT id, skill_allowlist FROM telegram_groups ORDER BY id",
      );
      expect(result.rows).toEqual([
        { id: 1, skill_allowlist: ["agent-browser", "xlsx"] },
        { id: 2, skill_allowlist: ["pdf"] },
        { id: 3, skill_allowlist: ["docx"] },
        { id: 4, skill_allowlist: [] },
      ]);
      expect(GROUP_SAFE_SKILL_NAMES).not.toContain("pohuy");
      expect(GROUP_SAFE_SKILL_NAMES).not.toContain("t-invest");
    } finally {
      client.release();
    }
  });
});
