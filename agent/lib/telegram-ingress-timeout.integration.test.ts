/** A timed-out turn must not lend its old boundary to the next queued message. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramDispatchControl, TelegramDrainContext } from "eve/channels/telegram";
import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { sessionRepository } from "./sessions/session-repository.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("Telegram queue after a session timeout", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families, telegram_ingress_queues, eve_session_event_cursors CASCADE"); });
  afterAll(closeDatabase);

  it("starts a fresh canonical session and consumes separate boundaries for the next two messages", async () => {
    const fixture = await createMainAgentMemoryFixture();
    for (const id of [1, 2, 3]) {
      await telegramIngressRepository.enqueue({
        continuationKey: "-1001::",
        payload: { update_id: id, message: {
          message_id: id, date: 1_700_000_000,
          chat: { id: -1001, type: "supergroup" },
          from: { id: 101, first_name: "User", is_bot: false },
          text: `@osinara_bot message ${id}`,
        } },
        updateId: String(id),
      });
    }
    const sessionIds: string[] = [];
    type Event = { type: string; data?: Record<string, unknown> };
    const events = new Map<string, Event[]>();
    const dispatch = vi.fn(async (_update: unknown, control?: TelegramDispatchControl) => {
      if (!control) throw new Error("TEST_DISPATCH_CONTROL_MISSING");
      const coordinate = { osinaraTelegramIngressId: control.dispatchId };
      const appSession = await sessionRepository.prepareTurn({
        baseContinuationToken: `osinara:group:${fixture.groupId}:main`,
        familyId: fixture.familyId, groupId: fixture.groupId, kind: "canonical",
        now: new Date(), scope: "family", telegramForumTopicId: null, userId: null,
      });
      const id = `eve-${appSession.generation}`;
      await sessionRepository.bindEveSession(appSession.id, id);
      sessionIds.push(id);
      const history = events.get(id) ?? [];
      events.set(id, history);
      const first = sessionIds.length === 1;
      if (first) history.push({ type: "session.waiting", data: { osinaraTelegramIngressId: "older-autonomous-HITL" } });
      history.push({ type: "turn.started", data: { ...coordinate, turnId: `turn_${sessionIds.length}` } });
      if (!first) history.push({ type: "turn.completed", data: coordinate }, { type: "session.waiting", data: coordinate });
      const readers = new Set<ReadableStreamDefaultController<Event>>();
      return {
        id,
        async cancel({ turnId }: { turnId: string }) {
          const ending = [{ type: "turn.cancelled", data: { ...coordinate, turnId } }, { type: "session.waiting", data: coordinate }];
          history.push(...ending);
          for (const reader of readers) for (const event of ending) reader.enqueue(event);
          return { status: "accepted", sessionId: id } as const;
        },
        async getEventStream(options?: { startIndex?: number }) {
          let reader: ReadableStreamDefaultController<Event>;
          return new ReadableStream({
            start(c) { reader = c; readers.add(c); for (const event of history.slice(options?.startIndex ?? 0)) c.enqueue(event); },
            cancel() { readers.delete(reader); },
          });
        },
      };
    });
    const ingress = createTelegramDurableIngress({
      acceptMedia: vi.fn(), authorizeVoice: vi.fn(), botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn(), leaseMilliseconds: 300,
      observerIdleMilliseconds: 300,
      repository: telegramIngressRepository, transcribeVoice: vi.fn(),
    });
    let running: Promise<unknown> | undefined;
    await ingress.drain({
      notifyTimeout: vi.fn(),
      dispatch: dispatch as unknown as TelegramDrainContext["dispatch"],
      waitUntil(task) { running = task; },
    });
    await running;

    expect(sessionIds).toEqual(["eve-0", "eve-1", "eve-1"]);
    expect((await database().query(
      "SELECT status, eve_session_id FROM telegram_ingress_updates ORDER BY update_id",
    )).rows).toEqual([
      { status: "failed", eve_session_id: "eve-0" },
      { status: "completed", eve_session_id: "eve-1" },
      { status: "completed", eve_session_id: "eve-1" },
    ]);
    expect(await telegramIngressRepository.sessionEventStreamCursor("eve-1")).toBe(6);
  });

  it.each(["observer", "crash"] as const)("persists %s quarantine across drains without blocking an independent chat", async (failure) => {
    for (const [id, chat] of [[1, -1001], [2, -1001], [3, -1002]] as const) {
      await telegramIngressRepository.enqueue({ continuationKey: `${chat}::`, updateId: String(id),
        payload: { update_id: id, message: { message_id: id, date: 1700000000,
          chat: { id: chat, type: "supergroup" }, from: { id: 101, first_name: "User", is_bot: false }, text: "hi" } } });
    }
    const dispatch = vi.fn(async (update, control?: TelegramDispatchControl) => update.message.chat.id === "-1001" ? {
      id: "unconfirmed-session", cancel: vi.fn().mockResolvedValue({ status: "accepted", sessionId: "unconfirmed-session" }),
      getEventStream: async () => new ReadableStream({ start(c) { c.enqueue({ type: "turn.started", data: { turnId: "turn_0", osinaraTelegramIngressId: control!.dispatchId } }); } }),
    } : null);
    const notifyTimeout = vi.fn();
    if (failure === "crash") {
      const claim = await telegramIngressRepository.claimNext(1000);
      if (!claim) throw new Error("TEST_INGRESS_CLAIM_MISSING");
      await telegramIngressRepository.beginDispatch(claim.updateId, claim.leaseToken);
      await database().query("UPDATE telegram_ingress_updates SET lease_expires_at=now()-interval '1 second' WHERE update_id=$1", [claim.updateId]);
    }
    const ingress = createTelegramDurableIngress({
      acceptMedia: vi.fn(), authorizeVoice: vi.fn(), botUsername: "osinara_bot", handleSoftwareUpdateCallback: vi.fn(),
      leaseMilliseconds: 100, cancellationMilliseconds: 50, repository: telegramIngressRepository, transcribeVoice: vi.fn(),
      observerIdleMilliseconds: 100,
    });
    let running: Promise<unknown> | undefined;
    const context = { dispatch: dispatch as TelegramDrainContext["dispatch"], notifyTimeout, waitUntil(task: Promise<unknown>) { running = task; } };
    await ingress.drain(context);
    await running;
    await ingress.drain(context);
    await running;
    expect(dispatch).toHaveBeenCalledTimes(failure === "crash" ? 1 : 2);
    expect(notifyTimeout).toHaveBeenCalledTimes(1);
    expect((await database().query("SELECT status, last_error_code FROM telegram_ingress_updates ORDER BY update_id")).rows).toEqual([
      { status: "failed", last_error_code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" },
      { status: "pending", last_error_code: null },
      { status: "completed", last_error_code: null },
    ]);
    expect(await telegramIngressRepository.claimNext(1000)).toBeNull();
  });
});
