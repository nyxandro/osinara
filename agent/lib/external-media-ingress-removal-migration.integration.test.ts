/**
 * External media ingress cleanup migration tests.
 *
 * Constructs covered:
 * - `020_reject_external_media_ingress.sql`: terminally closes legacy queued external media.
 * - `022_remove_legacy_group_media_payloads.sql`: tombstones and removes ambiguous queued payloads.
 * - Family media and external text updates remain untouched.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const TEST_SCHEMA = "external_media_ingress_removal_test";

describeWithDatabase("020 external media ingress cleanup migration", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("fails only non-terminal media queued for external groups", async () => {
    const migrationSql = await readFile(
      resolve("migrations/020_reject_external_media_ingress.sql"),
      "utf8",
    );
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE telegram_groups (
          telegram_chat_id text PRIMARY KEY,
          type text NOT NULL
        );
        CREATE TABLE telegram_ingress_updates (
          update_id bigint PRIMARY KEY,
          payload jsonb NOT NULL,
          status text NOT NULL,
          lease_token uuid,
          lease_expires_at timestamptz,
          last_error_code text,
          last_error_message text,
          completed_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO telegram_groups (telegram_chat_id, type)
        VALUES ('-100-external', 'external_public'), ('-100-family', 'family_private');
        INSERT INTO telegram_ingress_updates
          (update_id, payload, status, lease_token, lease_expires_at)
        VALUES
          (1, '{"message":{"chat":{"id":"-100-external"},"document":{}}}', 'pending', NULL, NULL),
          (2, '{"message":{"chat":{"id":"-100-external"},"voice":{}}}', 'processing', gen_random_uuid(), now() + interval '1 minute'),
          (3, '{"message":{"chat":{"id":"-100-external"},"text":"hello"}}', 'pending', NULL, NULL),
          (4, '{"message":{"chat":{"id":"-100-family"},"photo":[]}}', 'pending', NULL, NULL),
          (5, '{"message":{"chat":{"id":"-100-external"},"poll":{"question":"text"}}}', 'pending', NULL, NULL),
          (6, '{"message":{"chat":{"id":"-100-external"},"rich_message":{"media":{"file_id":"file-6"}}}}', 'pending', NULL, NULL);
      `);

      await client.query(migrationSql);

      const rows = await client.query<{
        last_error_code: string | null;
        lease_token: string | null;
        status: string;
        update_id: string;
      }>(
        "SELECT update_id::text, status, lease_token::text, last_error_code FROM telegram_ingress_updates ORDER BY update_id",
      );
      expect(rows.rows).toEqual([
        { last_error_code: "AGENT_EXTERNAL_MEDIA_IGNORED", lease_token: null, status: "failed", update_id: "1" },
        { last_error_code: "AGENT_EXTERNAL_MEDIA_IGNORED", lease_token: null, status: "failed", update_id: "2" },
        { last_error_code: null, lease_token: null, status: "pending", update_id: "3" },
        { last_error_code: null, lease_token: null, status: "pending", update_id: "4" },
        { last_error_code: null, lease_token: null, status: "pending", update_id: "5" },
        { last_error_code: "AGENT_EXTERNAL_MEDIA_IGNORED", lease_token: null, status: "failed", update_id: "6" },
      ]);
    } finally {
      client.release();
    }
  });

  it("tombstones queued group media without affecting private media or group text", async () => {
    const schemaSql = await readFile(
      resolve("migrations/021_tombstone_ignored_telegram_media.sql"),
      "utf8",
    );
    const cleanupSql = await readFile(
      resolve("migrations/022_remove_legacy_group_media_payloads.sql"),
      "utf8",
    );
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE telegram_ingress_updates (
          update_id bigint PRIMARY KEY,
          payload jsonb NOT NULL,
          status text NOT NULL,
          lease_token uuid,
          lease_expires_at timestamptz,
          last_error_code text,
          last_error_message text,
          completed_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO telegram_ingress_updates
          (update_id, payload, status, last_error_code, last_error_message)
        VALUES
          (11, '{"message":{"chat":{"id":"-1001","type":"supergroup"},"document":{}}}', 'pending', NULL, NULL),
          (12, '{"message":{"chat":{"id":"101","type":"private"},"document":{}}}', 'pending', NULL, NULL),
          (13, '{"message":{"chat":{"id":"-1001","type":"supergroup"},"text":"hello"}}', 'pending', NULL, NULL),
          (14, '{"message":{"chat":{"id":"-1001","type":"supergroup"},"poll":{"question":"text"}}}', 'pending', NULL, NULL),
          (15, '{"message":{"chat":{"id":"-1001","type":"supergroup"},"poll":{"media":{"file_id":"file-15"}}}}', 'pending', NULL, NULL),
          (16, '{"message":{"chat":{"id":"-1001","type":"supergroup"},"voice":{}}}', 'failed', 'AGENT_EXTERNAL_MEDIA_IGNORED', 'ignored');
      `);

      await client.query(schemaSql);
      await client.query(cleanupSql);

      const rows = await client.query<{ status: string; update_id: string }>(
        "SELECT update_id::text, status FROM telegram_ingress_updates ORDER BY update_id",
      );
      expect(rows.rows).toEqual([
        { status: "pending", update_id: "12" },
        { status: "pending", update_id: "13" },
        { status: "pending", update_id: "14" },
      ]);
      const ignored = await client.query<{ update_id: string }>(
        "SELECT update_id::text FROM telegram_ingress_ignored_updates",
      );
      expect(ignored.rows).toEqual([
        { update_id: "11" },
        { update_id: "15" },
        { update_id: "16" },
      ]);
    } finally {
      client.release();
    }
  });
});
