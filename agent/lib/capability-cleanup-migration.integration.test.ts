/**
 * Removed capability migration integration test.
 *
 * Constructs:
 * - `017_remove_shopping_and_routine_subsystems.sql`: drops obsolete persisted domains.
 * - Exact action-level migration of existing external-group tool permissions.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const TEST_SCHEMA = "capability_cleanup_migration_test";

describeWithDatabase("017 capability cleanup migration", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("drops removed domains and preserves exact external-group permissions", async () => {
    const migrationSql = await readFile(
      resolve("migrations/017_remove_shopping_and_routine_subsystems.sql"),
      "utf8",
    );
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);

      // Minimal pre-migration schema isolates the destructive migration from application fixtures.
      await client.query(`
        CREATE TYPE shopping_item_status AS ENUM ('pending', 'purchased');
        CREATE TYPE shopping_list_status AS ENUM ('active', 'archived');
        CREATE TABLE shopping_lists (id integer);
        CREATE TABLE shopping_items (id integer);
        CREATE TABLE shopping_operations (id integer);
        CREATE TABLE routine_observations (id integer);
        CREATE TABLE routine_observation_events (id integer);
        CREATE TABLE telegram_groups (id integer PRIMARY KEY, tool_allowlist text[] NOT NULL);
        INSERT INTO telegram_groups (id, tool_allowlist)
        VALUES (1, ARRAY[
          'edit_memory', 'forget', 'undo_memory', 'delete_workspace_file',
          'move_workspace_file', 'observe_routine', 'remember'
        ]);
      `);

      await client.query(migrationSql);

      const group = await client.query<{ tool_allowlist: string[] }>(
        "SELECT tool_allowlist FROM telegram_groups WHERE id = 1",
      );
      expect(group.rows[0]?.tool_allowlist).toEqual([
        "manage_memory.edit",
        "manage_memory.delete",
        "manage_memory.undo",
        "remove_group_file",
        "remember",
      ]);
      const removedTables = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.tables
         WHERE table_schema = $1
           AND table_name IN (
             'shopping_lists', 'shopping_items', 'shopping_operations',
             'routine_observations', 'routine_observation_events'
           )`,
        [TEST_SCHEMA],
      );
      expect(removedTables.rows[0]?.count).toBe("0");
    } finally {
      client.release();
    }
  });
});
