/** A durable pre-model fence distinguishes an interrupted preparation from an executing turn. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { database, closeDatabase } from "./database.js";
import { telegramIngressRepository as repository } from "./telegram-ingress-repository.js";
import { bindTelegramIngressTurn } from "./telegram-ingress-binding.js";
import { recoverUnboundTelegramPreparation } from "./telegram-preparation-recovery.js";
import { closeExpiredUnboundTelegramIngress } from "./telegram-ingress-recovery-admin.js";
import { NO_BURST_WAIT } from "./telegram-ingress.test-fixtures.js";

const suite = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
suite("interrupted Telegram preparation", () => {
  beforeEach(async () => { await database().query("TRUNCATE telegram_ingress_queues CASCADE"); });
  afterAll(closeDatabase);
  async function started() {
    await repository.enqueue({ updateId: "42", continuationKey: "101::", payload: { update_id: 42,
      message: { message_id: 42, date: 1700000000, chat: { id: 101, type: "private" }, text: "request" } } });
    const claim = (await repository.claimNext(60000, NO_BURST_WAIT))!;
    const dispatchId = crypto.randomUUID();
    await repository.beginDispatch("42", claim.leaseToken, dispatchId);
    return { claim, dispatchId };
  }
  it("revokes an unbound attempt before allowing preparation to resume", async () => {
    const { claim, dispatchId } = await started();
    await database().query("UPDATE telegram_ingress_updates SET recovery_protocol=1 WHERE update_id=42");
    expect(await recoverUnboundTelegramPreparation(claim.updateId, claim.leaseToken)).toBe("released");
    const auth = { initiator: null, current: { authenticator: "telegram", principalId: "101", principalType: "user",
      attributes: { osinaraTelegramUpdateId: "42", osinaraTelegramIngressId: dispatchId } } };
    await expect(bindTelegramIngressTurn(auth, "eve-old", "turn_0")).rejects.toThrow("AGENT_TELEGRAM_DISPATCH_BINDING_REJECTED");
    expect((await repository.claimNext(60000, NO_BURST_WAIT))?.dispatchStarted).toBe(false);
  });
  it("never releases a turn that has acquired its durable execution binding", async () => {
    const { claim, dispatchId } = await started();
    await database().query("UPDATE telegram_ingress_updates SET recovery_protocol=1 WHERE update_id=42");
    await bindTelegramIngressTurn({ initiator: null, current: { authenticator: "telegram", principalId: "101", principalType: "user",
      attributes: { osinaraTelegramUpdateId: "42", osinaraTelegramIngressId: dispatchId } } }, "eve-live", "turn_0");
    expect(await recoverUnboundTelegramPreparation(claim.updateId, claim.leaseToken)).toBe("bound");
    expect((await database().query("SELECT dispatch_session_id FROM telegram_ingress_updates WHERE update_id=42")).rows[0].dispatch_session_id).toBe("eve-live");
  });
  it("requires explicit reconciliation for shipped starts without the new protocol", async () => {
    const { claim } = await started();
    await database().query("UPDATE telegram_ingress_updates SET recovery_protocol=0 WHERE update_id=42");
    expect(await recoverUnboundTelegramPreparation(claim.updateId, claim.leaseToken)).toBe("legacy");
  });
  it("closes only the exact expired unbound attempt and releases the next message without replay", async () => {
    const { claim, dispatchId } = await started();
    await repository.fail("42", claim.leaseToken, { code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", message: "Unbound start" });
    await database().query("UPDATE telegram_ingress_updates SET dispatch_started_at=now()-interval '20 minutes' WHERE update_id=42");
    await closeExpiredUnboundTelegramIngress("42", dispatchId, "Verified pre-model admission fence");
    expect((await database().query("SELECT last_error_code FROM telegram_ingress_updates WHERE update_id=42")).rows[0].last_error_code)
      .toBe("AGENT_TELEGRAM_PROCESSING_INTERRUPTED");
    await expect(closeExpiredUnboundTelegramIngress("42", dispatchId, "again")).rejects.toThrow("AGENT_TELEGRAM_RECOVERY_NOT_ADMISSIBLE");
  });
});
