/** A blocked incident table must not indefinitely block an otherwise usable agent turn. */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, database } from "./database.js";
import { recordMemoryContextIncident } from "./memory-context-failure.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
describe.skipIf(!enabled)("bounded memory incident persistence", () => {
  afterAll(closeDatabase);
  it("ends the incident attempt while the table is still locked and releases its connection", async () => {
    const lock = await database().connect();
    const sessionId = `test-${randomUUID()}`;
    let pending: Promise<unknown> | undefined;
    let settled = false;
    try {
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE operational_incidents IN ACCESS EXCLUSIVE MODE");
      pending = recordMemoryContextIncident({ causeCode: "AGENT_TEST_FAILED", phase: "embedding",
        runId: null, scheduleId: null, sessionId, turnId: "turn_0",
      }).then(() => { settled = true; return "succeeded"; }, error => { settled = true; return error; });
      await delay(2200);
      expect(settled).toBe(true);
      expect(await pending).toBeInstanceOf(Error);
    } finally {
      await lock.query("ROLLBACK"); lock.release();
      await pending;
      await database().query("DELETE FROM operational_incidents WHERE operation_key=$1", [`memory-context:${sessionId}:turn_0`]);
    }
    expect(database().waitingCount).toBe(0);
  }, 10000);
});
