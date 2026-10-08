/**
 * Memory conflict tool grant cleanup migration integration test.
 *
 * Constructs covered:
 * - `132_remove_memory_conflict_grants.sql`: removes the deleted tool from every persisted external
 *   allowlist, which would otherwise invalidate the whole group policy, and keeps every other grant.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { parseExternalGroupToolAllowlist } from "./tool-policy/group-tool-catalog.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const TEST_SCHEMA = "memory_conflict_grant_cleanup_test";

describeWithDatabase("132 memory conflict grant cleanup", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("removes manage_memory_conflict from every persisted allowlist and keeps the policy valid", async () => {
    const migrationSql = await readFile(resolve("migrations/132_remove_memory_conflict_grants.sql"), "utf8");
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      // Four production groups held this grant on 08.10.2026.
      await client.query(`
        CREATE TABLE telegram_groups (id integer PRIMARY KEY, tool_allowlist text[] NOT NULL);
        INSERT INTO telegram_groups (id, tool_allowlist) VALUES
          (1, ARRAY['remember', 'manage_memory_conflict', 'search_memories']),
          (2, ARRAY['search_memories']);
      `);

      await client.query(migrationSql);

      const result = await client.query<{ id: number; tool_allowlist: string[] }>(
        "SELECT id, tool_allowlist FROM telegram_groups ORDER BY id",
      );
      expect(result.rows).toEqual([
        { id: 1, tool_allowlist: ["remember", "search_memories"] },
        { id: 2, tool_allowlist: ["search_memories"] },
      ]);
      expect(parseExternalGroupToolAllowlist(result.rows[0]!.tool_allowlist)).not.toBeNull();
    } finally {
      client.release();
    }
  });
});
