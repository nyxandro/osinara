/**
 * Removed document-parser capability migration tests.
 *
 * Constructs covered:
 * - `019_remove_document_parser.sql`: removes obsolete external-group PDF tool grants.
 * - Unrelated external-group permissions remain unchanged.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const TEST_SCHEMA = "document_parser_removal_test";

describeWithDatabase("019 document parser removal migration", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("removes only inspect_workspace_pdf from persisted allowlists", async () => {
    const migrationSql = await readFile(
      resolve("migrations/019_remove_document_parser.sql"),
      "utf8",
    );
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE telegram_groups (id integer PRIMARY KEY, tool_allowlist text[] NOT NULL);
        INSERT INTO telegram_groups (id, tool_allowlist)
        VALUES (1, ARRAY['inspect_workspace_pdf', 'inspect_workspace_image', 'remember']);
      `);

      await client.query(migrationSql);

      const group = await client.query<{ tool_allowlist: string[] }>(
        "SELECT tool_allowlist FROM telegram_groups WHERE id = 1",
      );
      expect(group.rows[0]?.tool_allowlist).toEqual(["inspect_workspace_image", "remember"]);
    } finally {
      client.release();
    }
  });
});
