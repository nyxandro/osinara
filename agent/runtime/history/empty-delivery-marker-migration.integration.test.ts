/**
 * Migration 125: the "stay silent" marker in stored conversation history.
 *
 * Constructs covered:
 * - Every stored message with the previous marker carries the current one afterwards.
 * - Messages without it keep their exact stored text.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../../lib/database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_empty_delivery_marker_migration";
const MIGRATION_NAME = "125_empty_delivery_marker.sql";

const SILENT = { role: "assistant", content: [{ type: "text", text: "Промолчу. <eve-empty-delivery/>" }] };
const SILENT_STRING = { role: "assistant", content: "<eve-empty-delivery/>" };
const ORDINARY = { role: "user", content: [{ type: "text", text: "Привет,   «мир»" }] };

describeWithDatabase("125 empty delivery marker migration", () => {
  afterAll(closeDatabase);

  it("rewrites the previous marker and leaves every other message byte for byte", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE agent_session_history (
          session_id text NOT NULL,
          generation integer NOT NULL,
          position integer NOT NULL,
          message json NOT NULL,
          PRIMARY KEY (session_id, generation, position)
        )`);
      // The ordinary message keeps irregular spacing: `json` stores the text as written.
      const ordinaryText = `{"role": "user",  "content": ${JSON.stringify(ORDINARY.content)}}`;
      await client.query(
        `INSERT INTO agent_session_history (session_id, generation, position, message)
         VALUES ('s', 0, 0, $1::json), ('s', 0, 1, $2::json), ('s', 0, 2, $3::json)`,
        [JSON.stringify(SILENT), JSON.stringify(SILENT_STRING), ordinaryText],
      );

      await client.query(await readFile(resolve(process.cwd(), "migrations", MIGRATION_NAME), "utf8"));

      const rows = await client.query<{ message: string }>(
        "SELECT message::text AS message FROM agent_session_history ORDER BY position",
      );
      expect(rows.rows.map((row) => JSON.parse(row.message))).toEqual([
        { role: "assistant", content: [{ type: "text", text: "Промолчу. <empty-delivery/>" }] },
        { role: "assistant", content: "<empty-delivery/>" },
        ORDINARY,
      ]);
      expect(rows.rows[2]!.message).toBe(ordinaryText);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
  });
});
