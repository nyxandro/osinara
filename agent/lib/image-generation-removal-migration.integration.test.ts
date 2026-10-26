/**
 * Image generation removal migration integration test.
 *
 * Constructs:
 * - `139_remove_image_generation.sql`: drops the generation journal of the removed subscription
 *   gateway and the `generate_image` grant, which would otherwise make a group's whole policy unreadable.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const TEST_SCHEMA = "image_generation_removal_migration_test";

describeWithDatabase("139 image generation removal migration", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("drops the generation journal and only the generate_image grant", async () => {
    const migrationSql = await readFile(resolve("migrations/139_remove_image_generation.sql"), "utf8");
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      // Minimal pre-migration schema isolates the destructive migration from application fixtures.
      await client.query(`
        CREATE TABLE image_generation_operations (id integer PRIMARY KEY);
        CREATE INDEX image_generation_operations_workspace ON image_generation_operations (id);
        CREATE TABLE telegram_groups (id integer PRIMARY KEY, tool_allowlist text[] NOT NULL);
        INSERT INTO telegram_groups (id, tool_allowlist) VALUES
          (1, ARRAY['remember', 'generate_image', 'bash']),
          (2, ARRAY['search_memories']);
      `);

      await client.query(migrationSql);

      const table = await client.query(
        "SELECT to_regclass($1) AS relation", [`${TEST_SCHEMA}.image_generation_operations`],
      );
      expect(table.rows[0]?.relation).toBeNull();
      const groups = await client.query<{ id: number; tool_allowlist: string[] }>(
        "SELECT id, tool_allowlist FROM telegram_groups ORDER BY id",
      );
      expect(groups.rows).toEqual([
        { id: 1, tool_allowlist: ["remember", "bash"] },
        { id: 2, tool_allowlist: ["search_memories"] },
      ]);
    } finally {
      await client.query("SET search_path TO public");
      client.release();
    }
  });
});
