/** Real PostgreSQL + a restarted ingress observer: never replay model/tool/delivery work. */
import type { SessionAuth } from "eve/context";
import type { TelegramDrainContext } from "eve/channels/telegram";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { database, closeDatabase } from "./database.js";
import { telegramIngressRepository as repository } from "./telegram-ingress-repository.js";
import { bindTelegramIngressTurn } from "./telegram-ingress-binding.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { requestTelegramIngressRecovery } from "./telegram-ingress-recovery-admin.js";
import { withRuntimeAdmission } from "./runtime-maintenance.js";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const id = "123e4567-e89b-42d3-a456-426614174000";
function auth(updateId = "1", dispatchId = id): SessionAuth {
  const actor = { authenticator: "telegram", principalId: "101", principalType: "user" as const,
    attributes: { osinaraTelegramUpdateId: updateId, osinaraTelegramIngressId: dispatchId } };
  return { current: actor, initiator: actor };
}
async function enqueue(updateId: string, callback = false) {
  const message = { message_id: Number(updateId), date: 1700000000,
    chat: { id: 101, type: "private" }, from: { id: 101, first_name: "Owner", is_bot: false }, text: "request" };
  await repository.enqueue({ continuationKey: "101::", updateId, payload: {
    update_id: Number(updateId), ...(callback ? { callback_query: {
      id: updateId, chat_instance: "chat", data: "eve:test", from: message.from, message,
    } } : { message }),
  } });
}

describeDatabase("Telegram restart recovery", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_ingress_queues, eve_session_event_cursors CASCADE");
    await database().query("UPDATE runtime_maintenance SET phase='ready',owner_token=NULL");
  });
  afterAll(closeDatabase);
  afterEach(async () => {
    await database().query("TRUNCATE telegram_ingress_queues, eve_session_event_cursors CASCADE");
    await database().query("UPDATE runtime_maintenance SET phase='ready',owner_token=NULL");
  });

  it.each(["lease-expired", "quarantined", "interrupted"])("reattaches %s execution and releases the next message without repeating work", async (failure) => {
    await enqueue("1"); await enqueue("2");
    const old = (await repository.claimNext(60000))!;
    await repository.beginDispatch(old.updateId, old.leaseToken, id);
    await database().query("INSERT INTO eve_session_event_cursors(eve_session_id,next_event_index) VALUES ('eve-1', 10)");
    await bindTelegramIngressTurn(auth(), "eve-1", "turn_7");
    if (failure === "lease-expired") {
      await database().query("UPDATE telegram_ingress_updates SET lease_expires_at=now()-interval '1 second' WHERE update_id=1");
    } else {
      await repository.fail("1", old.leaseToken, { code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", message: "test observer loss" }, "eve-1");
    }
    const dispatch = vi.fn(async (_update: unknown) => null);
    const read = vi.fn(async () => new ReadableStream({ start(c) {
      c.enqueue({ type: "session.waiting", data: { osinaraTelegramIngressId: "earlier" } });
      c.enqueue({ type: failure === "interrupted" ? "turn.cancelled" : "message.completed", data: { osinaraTelegramIngressId: id } });
      c.enqueue({ type: "session.waiting", data: { osinaraTelegramIngressId: id } }); c.close();
    } }));
    const attachSession = vi.fn(() => ({ id: "eve-1", getEventStream: read, cancel: vi.fn() }));
    const restarted = createTelegramDurableIngress({ repository, botUsername: "osinara_bot", leaseMilliseconds: 60000,
      observerIdleMilliseconds: 100, cancellationMilliseconds: 50, acceptMedia: vi.fn(), authorizeVoice: vi.fn(),
      handleSoftwareUpdateCallback: vi.fn(), transcribeVoice: vi.fn(),
    });
    const tasks: Promise<unknown>[] = [];
    await restarted.drain({ attachSession, dispatch, notifyTimeout: vi.fn(), waitUntil: (task: Promise<unknown>) => { tasks.push(task); } } as unknown as TelegramDrainContext);
    await Promise.all(tasks);
    expect(attachSession).toHaveBeenCalledWith("eve-1");
    expect(read).toHaveBeenCalledWith({ startIndex: 10 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ message: { messageId: "2" } });
    expect((await database().query("SELECT status FROM telegram_ingress_updates ORDER BY update_id")).rows)
      .toEqual([{ status: failure === "interrupted" ? "failed" : "completed" }, { status: "completed" }]);
    if (failure !== "interrupted") expect(await repository.sessionEventStreamCursor("eve-1")).toBe(13);
  });

  it("rejects binding to another attempt or session and never overwrites provenance", async () => {
    await enqueue("1");
    const claim = (await repository.claimNext(60000))!;
    await repository.beginDispatch("1", claim.leaseToken, id);
    await expect(bindTelegramIngressTurn(auth("1", crypto.randomUUID()), "eve-1", "turn_1"))
      .rejects.toThrow("AGENT_TELEGRAM_DISPATCH_BINDING_REJECTED");
    await bindTelegramIngressTurn(auth(), "eve-1", "turn_1");
    await expect(bindTelegramIngressTurn(auth(), "eve-2", "turn_1"))
      .rejects.toThrow("AGENT_TELEGRAM_DISPATCH_BINDING_REJECTED");
    await repository.completeWithSession("1", claim.leaseToken, "eve-1", 2);
    await expect(bindTelegramIngressTurn(auth(), "eve-1", "turn_1"))
      .rejects.toThrow("AGENT_TELEGRAM_DISPATCH_BINDING_REJECTED");
    await expect(bindTelegramIngressTurn(auth(), "eve-1", "turn_1", true)).resolves.toBeUndefined();
  });
  it("binds a partial approval boundary even when Eve does not start a new turn", async () => {
    await enqueue("1", true);
    const claim = (await repository.claimNext(60000))!;
    await repository.beginDispatch("1", claim.leaseToken, id);
    await database().query("INSERT INTO eve_session_event_cursors(eve_session_id,next_event_index) VALUES ('eve-1', 20)");
    await bindTelegramIngressTurn(auth(), "eve-1", "turn_9", true);
    await database().query("UPDATE telegram_ingress_updates SET lease_expires_at=now()-interval '1 second' WHERE update_id=1");
    expect((await repository.claimNext(60000))?.dispatchBinding)
      .toEqual({ id, sessionId: "eve-1", turnId: "turn_9", cursor: 20 });
  });

  it("does not infer a safe rerun for persisted legacy or unbound starts", async () => {
    await enqueue("1"); await enqueue("2");
    const claim = (await repository.claimNext(60000))!;
    await database().query("UPDATE telegram_ingress_updates SET dispatch_started_at=now() WHERE update_id=1");
    await repository.fail("1", claim.leaseToken, { code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", message: "legacy start" });
    expect(await repository.claimNext(60000)).toBeNull();
  });

  it("admits callbacks while draining but neither callbacks nor new messages when frozen", async () => {
    await enqueue("1", true); await enqueue("2");
    await database().query("UPDATE runtime_maintenance SET phase='draining',owner_token=$1", [id]);
    const callback = await repository.claimNext(60000);
    expect(callback?.updateId).toBe("1");
    await repository.complete("1", callback!.leaseToken);
    expect(await repository.claimNext(60000)).toBeNull();
    await database().query("UPDATE runtime_maintenance SET phase='frozen'");
    await enqueue("3", true);
    expect(await repository.claimNext(60000)).toBeNull();
    await database().query("UPDATE runtime_maintenance SET phase='ready',owner_token=NULL");
    expect((await repository.claimNext(60000))?.updateId).toBe("2");
  });

  it("bounds automatic recovery, and an audited operator request never erases quarantine", async () => {
    await enqueue("1"); await enqueue("2");
    let claim = (await repository.claimNext(60000))!;
    await repository.beginDispatch("1", claim.leaseToken, id);
    await bindTelegramIngressTurn(auth(), "eve-1", "turn_1");
    const failure = { code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", message: "test" };
    await repository.fail("1", claim.leaseToken, failure);
    for (let attempt = 0; attempt < 3; attempt++) {
      claim = (await repository.claimNext(60000))!;
      expect(claim.updateId).toBe("1");
      await repository.fail("1", claim.leaseToken, failure);
    }
    expect(await repository.claimNext(60000)).toBeNull();
    await requestTelegramIngressRecovery("1", "cancel", "Operator verified the blocked request");
    const state = (await database().query("SELECT status,last_error_code,recovery_cancel_requested FROM telegram_ingress_updates WHERE update_id=1")).rows[0];
    expect(state).toEqual({ status: "failed", last_error_code: failure.code, recovery_cancel_requested: true });
    expect((await database().query("SELECT action FROM telegram_ingress_recovery_events WHERE update_id=1")).rows)
      .toEqual([{ action: "cancel" }]);
    expect((await repository.claimNext(60000))?.updateId).toBe("1");
  });

  it("rejects operator recovery of an unbound legacy marker", async () => {
    await enqueue("1");
    const claim = (await repository.claimNext(60000))!;
    await database().query("UPDATE telegram_ingress_updates SET dispatch_started_at=now() WHERE update_id=1");
    await repository.fail("1", claim.leaseToken, { code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", message: "legacy" });
    await expect(requestTelegramIngressRecovery("1", "observe", "Inspect old dispatch"))
      .rejects.toThrow("AGENT_TELEGRAM_RECOVERY_NOT_ADMISSIBLE");
    expect((await database().query("SELECT * FROM telegram_ingress_recovery_events")).rows).toEqual([]);
  });

  it("keeps a deployment from declaring idle while an admitted schedule is still running", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const work = withRuntimeAdmission("ordinary", async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
    });
    try {
      await entered;
      await database().query("UPDATE runtime_maintenance SET phase='draining',owner_token=$1", [id]);
      expect((await database().query("SELECT count(*)::integer AS n FROM runtime_admission_holders")).rows[0].n).toBe(1);
      const next = vi.fn();
      expect(await withRuntimeAdmission("ordinary", next)).toBeNull();
      expect(next).not.toHaveBeenCalled();
      release();
      await work;
      expect((await database().query("SELECT count(*)::integer AS n FROM runtime_admission_holders")).rows[0].n).toBe(0);
    } finally { release?.(); await work; }
  });
});
