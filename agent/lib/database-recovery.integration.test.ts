/**
 * Database recovery probe against a real PostgreSQL.
 *
 * Constructs covered:
 * - node-postgres honours `query_timeout` given on the query itself and reports it with the exact
 *   message the recovery probe recognises; an upgrade that changes either breaks this test first.
 * - The timed-out connection leaves the pool, so the next probe is not poisoned by it.
 */
import type { QueryConfig } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { PG_QUERY_READ_TIMEOUT_MESSAGE } from "./database-recovery.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("the recovery probe's read timeout", () => {
  afterAll(async () => { await closeDatabase(); });

  it("stops a query that outlives its own timeout with the message the probe expects", async () => {
    // pg's types declare the field only on the client config; the probe states it the same way.
    const slow: QueryConfig & { query_timeout: number } = {
      text: "SELECT pg_sleep(3)",
      query_timeout: 300,
    };

    await expect(database().query(slow)).rejects.toThrowError(PG_QUERY_READ_TIMEOUT_MESSAGE);
    await expect(database().query("SELECT 1 AS ok")).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });
});
