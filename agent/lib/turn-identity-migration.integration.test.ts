/**
 * Migration 058: execution identity of turn-owned rows.
 *
 * Constructs covered:
 * - Existing turn-owned rows receive their verified agent session identity.
 * - Catch-up extraction rows remain explicitly sessionless.
 * - Repeated turn ids are isolated between agent sessions.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_eve_turn_identity_migration";
const MIGRATION_NAME = "058_scope_eve_turn_identity.sql";

describeWithDatabase("058 turn identity migration", () => {
  afterAll(closeDatabase);

  it("backfills persisted rows and scopes repeated turn ids by agent session", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);

      // This exact pre-058 surface keeps the migration test independent from later application code.
      await client.query(`
        CREATE TABLE conversation_sessions (
          id uuid PRIMARY KEY,
          eve_session_id text
        );
        CREATE TABLE memory_extraction_batches (
          id uuid PRIMARY KEY,
          conversation_id uuid NOT NULL,
          application_session_id uuid,
          turn_id text NOT NULL,
          extractor_version text NOT NULL,
          schema_version text NOT NULL,
          CONSTRAINT memory_extraction_batches_conversation_id_turn_id_extractor_key
            UNIQUE (conversation_id, turn_id, extractor_version, schema_version)
        );
        CREATE TABLE telegram_final_deliveries (
          id uuid PRIMARY KEY,
          eve_turn_id text NOT NULL,
          application_session_id uuid,
          CONSTRAINT telegram_final_deliveries_eve_turn_id_key UNIQUE (eve_turn_id)
        );
      `);
      await client.query(`
        INSERT INTO conversation_sessions (id, eve_session_id) VALUES
          ('00000000-0000-4000-8000-000000000001', 'wrun_existing'),
          ('00000000-0000-4000-8000-000000000002', 'wrun_second');
        INSERT INTO memory_extraction_batches
          (id, conversation_id, application_session_id, turn_id, extractor_version, schema_version)
        VALUES
          ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000021',
           '00000000-0000-4000-8000-000000000001', 'turn_0', 'extractor-v1', 'schema-v1'),
          ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000021',
           NULL, 'catchup:2:2', 'extractor-v1', 'schema-v1');
        INSERT INTO telegram_final_deliveries (id, eve_turn_id, application_session_id)
        VALUES ('00000000-0000-4000-8000-000000000031', 'turn_0',
                '00000000-0000-4000-8000-000000000001');
      `);

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      const batches = await client.query<{ eve_session_id: string | null; turn_id: string }>(
        `SELECT turn_id, eve_session_id FROM memory_extraction_batches ORDER BY turn_id`,
      );
      expect(batches.rows).toEqual([
        { eve_session_id: null, turn_id: "catchup:2:2" },
        { eve_session_id: "wrun_existing", turn_id: "turn_0" },
      ]);
      await expect(client.query(
        `INSERT INTO memory_extraction_batches
           (id, conversation_id, application_session_id, batch_kind, eve_session_id,
            turn_id, extractor_version, schema_version)
         VALUES ('00000000-0000-4000-8000-000000000013',
                 '00000000-0000-4000-8000-000000000021',
                 '00000000-0000-4000-8000-000000000002', 'turn', 'wrun_second',
                 'turn_0', 'extractor-v1', 'schema-v1')`,
      )).resolves.toHaveProperty("rowCount", 1);
      await expect(client.query(
        `INSERT INTO memory_extraction_batches
           (id, conversation_id, application_session_id, batch_kind, eve_session_id,
            turn_id, extractor_version, schema_version)
         VALUES ('00000000-0000-4000-8000-000000000014',
                 '00000000-0000-4000-8000-000000000021',
                 '00000000-0000-4000-8000-000000000002', 'turn', 'wrun_second',
                 'turn_0', 'extractor-v1', 'schema-v1')`,
      )).rejects.toMatchObject({ code: "23505" });

      const delivery = await client.query<{ eve_session_id: string }>(
        "SELECT eve_session_id FROM telegram_final_deliveries WHERE eve_turn_id = 'turn_0'",
      );
      expect(delivery.rows).toEqual([{ eve_session_id: "wrun_existing" }]);
      await expect(client.query(
        `INSERT INTO telegram_final_deliveries
           (id, eve_session_id, eve_turn_id, application_session_id)
         VALUES ('00000000-0000-4000-8000-000000000032', 'wrun_second', 'turn_0',
                 '00000000-0000-4000-8000-000000000002')`,
      )).resolves.toHaveProperty("rowCount", 1);
      await expect(client.query(
        `INSERT INTO telegram_final_deliveries
           (id, eve_session_id, eve_turn_id, application_session_id)
         VALUES ('00000000-0000-4000-8000-000000000033', 'wrun_second', 'turn_0',
                 '00000000-0000-4000-8000-000000000002')`,
      )).rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
  });
});
