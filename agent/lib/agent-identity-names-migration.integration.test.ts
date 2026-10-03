/**
 * Migrations 126 and 127: identifiers of the agent runtime under their own names.
 *
 * Constructs covered:
 * - The migrated schema has no table, column, constraint or index named after the previous runtime,
 *   and the turn identity columns are `agent_session_id` / `agent_turn_id`.
 * - Sessions carried over in v0.35 are labelled `imported`.
 * - Stored memory sources move to the `turn:` prefix; audit and incident keys to `agent…` names,
 *   while every other stored value stays as it was.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_agent_identity_data_migration";
const DATA_MIGRATION = "127_agent_identity_data.sql";
// Whole name segments only: `events`, `level` or `retrieval` contain the letters but are not it.
const PREVIOUS_NAME = "(^|_)eve(_|$)";

describeWithDatabase("126 agent identity names", () => {
  afterAll(closeDatabase);

  it("leaves no table, column, constraint or index named after the previous runtime", async () => {
    const leftovers = await database().query<{ kind: string; name: string }>(
      `SELECT 'table' AS kind, table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name ~ $1
       UNION ALL
       SELECT 'column', table_name || '.' || column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name ~ $1
       UNION ALL
       SELECT 'constraint', conname FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND conname ~ $1
       UNION ALL
       SELECT 'index', indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname ~ $1`,
      [PREVIOUS_NAME],
    );
    expect(leftovers.rows).toEqual([]);

    const identity = await database().query<{ name: string }>(
      `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('agent_session_id', 'agent_turn_id')
        ORDER BY 1`,
    );
    expect(identity.rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      "conversation_sessions.agent_session_id",
      "memory_turn_source_sets.agent_session_id",
      "memory_turn_source_sets.agent_turn_id",
      "telegram_final_deliveries.agent_turn_id",
    ]));
    expect(identity.rows).toHaveLength(27);
  });

  it("labels carried-over sessions as imported and drops the removed recovery state", async () => {
    const source = await database().query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'agent_session_state_source_check'`,
    );
    expect(source.rows[0]!.definition).toContain("'imported'");
    expect(source.rows[0]!.definition).not.toContain("_import'");

    const removed = await database().query<{ name: string }>(
      `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'telegram_ingress_updates'
          AND column_name IN ('recovery_attempts', 'recovery_cancel_requested')
       UNION ALL
       SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'telegram_ingress_recovery_events'`,
    );
    expect(removed.rows).toEqual([]);
  });
});

describeWithDatabase("127 agent identity data", () => {
  afterAll(closeDatabase);

  it("rewrites memory sources and stored keys and nothing else", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      // The exact columns 127 touches; the rest of each table does not take part.
      await client.query(`
        CREATE TABLE memory_items_all (id integer PRIMARY KEY, source text NOT NULL);
        CREATE TABLE audit_events (id integer PRIMARY KEY, metadata jsonb);
        CREATE TABLE operational_incidents (id integer PRIMARY KEY, context jsonb NOT NULL);
        INSERT INTO memory_items_all VALUES
          (1, 'eve:wrun_01M2:turn_3'), (2, 'automatic_extraction:batch'), (3, 'eve:legacy'),
          (4, 'explicit_correction:eve:kept');
        INSERT INTO audit_events VALUES
          (1, '{"failedEveSessionId": "wrun_a", "reason": "x"}'),
          (2, '{"previousEveSessionId": "wrun_b", "previousEveTurnId": "turn_1", "previousSessionId": "s"}'),
          (3, '{"eveSessionId": "wrun_c", "level": "eve", "nested": {"eveTurnId": "kept"}}'),
          (4, NULL),
          (5, '{"severity": "low"}');
        INSERT INTO operational_incidents VALUES
          (1, '{"chatId": "-1", "eveSessionId": "wrun_d", "eveTurnId": "turn_2"}'),
          (2, '{"updateId": "7"}');
      `);

      await client.query(await readFile(resolve(process.cwd(), "migrations", DATA_MIGRATION), "utf8"));

      const sources = await client.query<{ source: string }>("SELECT source FROM memory_items_all ORDER BY id");
      expect(sources.rows.map((row) => row.source)).toEqual([
        "turn:wrun_01M2:turn_3", "automatic_extraction:batch", "turn:legacy", "explicit_correction:eve:kept",
      ]);
      const audit = await client.query<{ metadata: unknown }>("SELECT metadata FROM audit_events ORDER BY id");
      expect(audit.rows.map((row) => row.metadata)).toEqual([
        { failedAgentSessionId: "wrun_a", reason: "x" },
        { previousAgentSessionId: "wrun_b", previousAgentTurnId: "turn_1", previousSessionId: "s" },
        { agentSessionId: "wrun_c", level: "eve", nested: { eveTurnId: "kept" } },
        null,
        { severity: "low" },
      ]);
      const incidents = await client.query<{ context: unknown }>("SELECT context FROM operational_incidents ORDER BY id");
      expect(incidents.rows.map((row) => row.context)).toEqual([
        { agentSessionId: "wrun_d", agentTurnId: "turn_2", chatId: "-1" },
        { updateId: "7" },
      ]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
  });
});
