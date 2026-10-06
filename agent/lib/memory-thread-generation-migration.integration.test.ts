/**
 * Memory thread generation removal migration integration test.
 *
 * The generation counter only served the brief cache that 128 removed; nothing reads it. Migration
 * 129 drops it while a changed source still moves its thread up by `updated_at`, which thread lists,
 * activation and similar-thread search order by.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { applyMigrationsBefore, seedEvidencedThread } from "./memory-thread-migration.integration-fixtures.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const MIGRATION_NAME = "129_drop_memory_thread_generation.sql";
const TEST_SCHEMA = "test_memory_thread_generation";

describeWithDatabase("129 memory thread generation removal", () => {
  afterAll(closeDatabase);

  it("drops the counter while a changed source still refreshes its thread", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyMigrationsBefore(client, MIGRATION_NAME);
      const { claim, thread } = await seedEvidencedThread(client, 129);

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      expect((await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'memory_threads' AND column_name = 'generation'`,
        [TEST_SCHEMA],
      )).rows).toEqual([]);

      const updatedAt = async () => (await client.query<{ updated_at: Date }>(
        "SELECT updated_at FROM memory_threads WHERE id = $1", [thread],
      )).rows[0]!.updated_at.getTime();
      // now() is the transaction start, so each change runs in its own transaction after a stale stamp.
      await client.query("UPDATE memory_threads SET updated_at = now() - interval '1 day' WHERE id = $1", [thread]);
      const stale = await updatedAt();
      await client.query("UPDATE memory_thread_entries SET occurred_at = now() - interval '1 hour' WHERE thread_id = $1", [thread]);
      expect(await updatedAt()).toBeGreaterThan(stale);

      await client.query("UPDATE memory_threads SET updated_at = now() - interval '1 day' WHERE id = $1", [thread]);
      const staleAgain = await updatedAt();
      await client.query("UPDATE memory_items SET content = 'Подготовка к марафону идёт' WHERE id = $1", [claim]);
      expect(await updatedAt()).toBeGreaterThan(staleAgain);

      expect((await client.query(
        "SELECT count(*)::integer AS entries FROM memory_thread_entries WHERE thread_id = $1", [thread],
      )).rows).toEqual([{ entries: 1 }]);
    } finally {
      try {
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        client.release();
      }
    }
  });
});
