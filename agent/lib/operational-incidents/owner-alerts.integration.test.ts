/** System diagnostics have one private recipient regardless of the originating chat. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { database, closeDatabase } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { recordOperationalIncident, dispatchOperationalIncidents } from "./owner-alerts.js";

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
suite("owner-only operational incidents", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families, operational_incidents CASCADE"); });
  afterAll(closeDatabase);

  it("deduplicates a failure cascade and sends only to the database owner", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const incident = { key: "telegram:42", code: "AGENT_TELEGRAM_INGRESS_FAILED",
      summary: "Не удалось обработать сообщение", context: { updateId: "42", chatId: "-1001" } };
    await recordOperationalIncident(incident);
    await recordOperationalIncident({ ...incident, code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" });
    const deliver = vi.fn().mockResolvedValue(undefined);
    await dispatchOperationalIncidents({ deliver });
    await dispatchOperationalIncidents({ deliver });
    const owner = (await database().query("SELECT telegram_user_id FROM users WHERE id=$1", [fixture.userId])).rows[0];
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ chatId: owner.telegram_user_id });
    expect(deliver.mock.calls[0]?.[0].chatId).not.toBe("-1001");
    expect((await database().query("SELECT status FROM operational_incidents")).rows).toEqual([{ status: "delivered" }]);
  });

  it("does not repeat an ambiguous Telegram send and still delivers independent incidents", async () => {
    await createMainAgentMemoryFixture();
    for (const key of ["first", "second"]) await recordOperationalIncident({ key, code: "AGENT_TEST_FAILURE", summary: "Сбой обработки", context: {} });
    const deliver = vi.fn().mockRejectedValueOnce(new Error("connection reset")).mockResolvedValue(undefined);
    await dispatchOperationalIncidents({ deliver });
    await dispatchOperationalIncidents({ deliver });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect((await database().query("SELECT status FROM operational_incidents ORDER BY created_at,id")).rows)
      .toEqual([{ status: "ambiguous" }, { status: "delivered" }]);
  });
});
