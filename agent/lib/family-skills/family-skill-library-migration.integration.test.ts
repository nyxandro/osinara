/**
 * Family skill library migration integration test.
 *
 * Constructs covered:
 * - `136_family_skill_library.sql`: a skill's author is whoever created its first version; a skill
 *   that worked for the whole family stays enabled for its author alone; a disabled or never confirmed
 *   one is enabled for nobody; the family-wide flag is gone; notices need exactly one recipient.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const TEST_SCHEMA = "family_skill_library_migration_test";

describeWithDatabase("136 family skill library", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("keeps a working skill on for its author only and drops the family-wide flag", async () => {
    const migrationSql = await readFile(resolve("migrations/136_family_skill_library.sql"), "utf8");
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      // The tables as migration 123 left them; doc-signing was the only production skill on 18.10.2026.
      await client.query(`
        CREATE TABLE families (id uuid PRIMARY KEY);
        CREATE TABLE users (id uuid PRIMARY KEY);
        CREATE TABLE telegram_groups (id uuid PRIMARY KEY);
        CREATE TABLE family_skills (
          id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES families(id), name text NOT NULL,
          enabled boolean NOT NULL DEFAULT false, active_version integer,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK (NOT enabled OR active_version IS NOT NULL)
        );
        CREATE TABLE family_skill_versions (skill_id uuid NOT NULL, version integer NOT NULL, created_by uuid);
        CREATE TABLE agent_tool_calls (tool_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
        INSERT INTO families VALUES ('00000000-0000-4000-8000-000000000001');
        INSERT INTO users VALUES ('00000000-0000-4000-8000-0000000000a1'), ('00000000-0000-4000-8000-0000000000a2');
        INSERT INTO family_skills (id, family_id, name, enabled, active_version) VALUES
          ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001', 'doc-signing', true, 1),
          ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-000000000001', 'off', false, 1),
          ('00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-000000000001', 'staged', false, NULL);
        INSERT INTO family_skill_versions VALUES
          ('00000000-0000-4000-8000-0000000000b1', 1, '00000000-0000-4000-8000-0000000000a1'),
          ('00000000-0000-4000-8000-0000000000b1', 2, '00000000-0000-4000-8000-0000000000a2'),
          ('00000000-0000-4000-8000-0000000000b2', 1, '00000000-0000-4000-8000-0000000000a2'),
          ('00000000-0000-4000-8000-0000000000b3', 1, '00000000-0000-4000-8000-0000000000a1');
      `);

      await client.query(migrationSql);

      expect((await client.query("SELECT name, author_user_id FROM family_skills ORDER BY name")).rows).toEqual([
        { author_user_id: "00000000-0000-4000-8000-0000000000a1", name: "doc-signing" },
        { author_user_id: "00000000-0000-4000-8000-0000000000a2", name: "off" },
        { author_user_id: "00000000-0000-4000-8000-0000000000a1", name: "staged" },
      ]);
      expect((await client.query("SELECT skill_id, user_id FROM family_skill_activations")).rows).toEqual([
        { skill_id: "00000000-0000-4000-8000-0000000000b1", user_id: "00000000-0000-4000-8000-0000000000a1" },
      ]);
      expect((await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'family_skills' AND column_name = 'enabled'`,
        [TEST_SCHEMA],
      )).rowCount).toBe(0);
      await expect(client.query(
        `INSERT INTO family_skill_notices (family_id, operation_key, text) VALUES ('00000000-0000-4000-8000-000000000001', 'k', 't')`,
      )).rejects.toThrow();
    } finally {
      client.release();
    }
  });
});
