/**
 * Schema binding of the Telegram failure recorder.
 *
 * `recordTelegramFailure` correlates a failed turn with its ingress update or scheduled run before
 * writing the incident. Both lookups are raw SQL against columns no unit test can see: every other
 * test of this path mocks the module, so a renamed column would surface only in production, at the
 * moment a turn is already failing and diagnostics matter most.
 *
 * Constructs covered:
 * - Both correlation statements execute against the live schema.
 * - With neither correlation available the incident is keyed by the Eve session and turn.
 */
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { recordTelegramFailure } from "./telegram-failure.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE");
}

describe.skipIf(!enabled)("telegram failure correlation", () => {
  afterAll(closeDatabase);

  it("runs both correlation lookups and falls back to the Eve session key", async () => {
    const sessionId = `test-${randomUUID()}`;
    const turnId = "turn_0";
    const operationKey = `eve:${sessionId}:${turnId}`;
    try {
      await recordTelegramFailure({
        chatId: "-100111",
        code: "AGENT_TEST_FAILED",
        sessionId,
        turnId,
      });

      const stored = await database().query<{ code: string; context: Record<string, unknown> }>(
        "SELECT code, context FROM operational_incidents WHERE operation_key=$1",
        [operationKey],
      );

      // Reaching this key proves both lookups ran and returned nothing: an unknown column would
      // have thrown instead, and a matching row would have produced a different key.
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]?.code).toBe("AGENT_TELEGRAM_EXECUTION_FAILED");
      expect(stored.rows[0]?.context).toMatchObject({
        causeCode: "AGENT_TEST_FAILED",
        chatId: "-100111",
        eveSessionId: sessionId,
        eveTurnId: turnId,
        updateId: null,
      });
    } finally {
      await database().query("DELETE FROM operational_incidents WHERE operation_key=$1", [operationKey]);
    }
  });

  it("accepts a known update id without consulting the ingress table", async () => {
    const sessionId = `test-${randomUUID()}`;
    const operationKey = "telegram:987654321";
    try {
      await recordTelegramFailure({
        code: "AGENT_TEST_FAILED",
        sessionId,
        updateId: "987654321",
      });

      const stored = await database().query<{ context: Record<string, unknown> }>(
        "SELECT context FROM operational_incidents WHERE operation_key=$1",
        [operationKey],
      );

      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]?.context).toMatchObject({ eveSessionId: sessionId, updateId: "987654321" });
    } finally {
      await database().query("DELETE FROM operational_incidents WHERE operation_key=$1", [operationKey]);
    }
  });
});
