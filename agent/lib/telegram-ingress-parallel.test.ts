/** A slow group must not block private approval buttons; each chat still has one FIFO head. */
import { describe, expect, it, vi } from "vitest";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { correlatedDispatch } from "./telegram-ingress.test-fixtures.js";
import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { TELEGRAM_INGRESS_CALLBACK_CONCURRENCY, TELEGRAM_INGRESS_MESSAGE_CONCURRENCY } from "../config.js";

describe("independent Telegram queue progress", () => {
  it.each(["none", "turn", "lease"] as const)("bounds turns and reserves callback capacity (failure: %s)", async failure => {
    const ordinary = TELEGRAM_INGRESS_MESSAGE_CONCURRENCY + 1, callbacks = TELEGRAM_INGRESS_CALLBACK_CONCURRENCY + 1;
    const items = Array.from({ length: ordinary + callbacks }, (_, index) => {
      const id = index + 1, callback = index >= ordinary;
      const from = { id: 100 + id, first_name: "User", is_bot: false };
      const message = { message_id: id, date: 1700000000, text: "request", from,
        chat: { id: callback ? 100 + id : -id, type: callback ? "private" : "group" } };
      return { updateId: String(id), queueId: String(id), leaseToken: String(id), voice: null, transcript: null,
        payload: { update_id: id, ...(callback ? { callback_query: { id: String(id), chat_instance: "chat", data: `eve:${id}`, from, message } } : { message }) } };
    });
    let releaseMessages!: () => void, releaseCallbacks!: () => void;
    const gates = { message: new Promise<void>(resolve => { releaseMessages = resolve; }), callback_query: new Promise<void>(resolve => { releaseCallbacks = resolve; }) };
    const active = { message: 0, callback_query: 0 }, maximum = { ...active };
    const dispatched: number[] = [], completed: number[] = [], work: Promise<unknown>[] = [];
    const repository = { claimNext: vi.fn(async () => items.shift() ?? null), beginDispatch: vi.fn(),
      renewLease: vi.fn(async (id: string) => { if (failure === "lease" && id === String(ordinary)) throw new Error("expected test lease loss"); }),
      sessionEventStreamCursor: vi.fn(async () => 0), completeWithSession: vi.fn(async (id: string) => { completed.push(Number(id)); }), fail: vi.fn() };
    const handler = createTelegramDurableIngress({ repository: repository as unknown as TelegramIngressRepository,
      botUsername: "osinara_bot", leaseMilliseconds: 60_000, acceptMedia: vi.fn(), authorizeVoice: vi.fn(),
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false), transcribeVoice: vi.fn() });
    try {
      for (let index = 0; index < ordinary + callbacks; index++) await handler.drain({ notifyTimeout: vi.fn(), waitUntil: task => { work.push(task); }, dispatch: correlatedDispatch(async update => {
        const id = Number(update.kind === "message" ? update.message.messageId : update.callbackQuery.message!.messageId);
        dispatched.push(id); active[update.kind]++; maximum[update.kind] = Math.max(maximum[update.kind], active[update.kind]);
        return { id: String(id), getEventStream: async () => new ReadableStream({ async start(controller) {
          await gates[update.kind]; active[update.kind]--;
          if (failure === "turn" && id === 1) { controller.error(new Error("expected test turn failure")); return; }
          controller.enqueue({ type: "session.waiting" }); controller.close();
        } }) } as never;
      }) });
      await vi.waitFor(() => expect(dispatched).toHaveLength(TELEGRAM_INGRESS_MESSAGE_CONCURRENCY + TELEGRAM_INGRESS_CALLBACK_CONCURRENCY));
      releaseCallbacks(); await vi.waitFor(() => expect(completed.filter(id => id > ordinary)).toHaveLength(callbacks));
      expect(dispatched.filter(id => id <= ordinary)).toHaveLength(TELEGRAM_INGRESS_MESSAGE_CONCURRENCY);
    } finally { releaseMessages(); releaseCallbacks(); await Promise.all(work); }
    expect(maximum).toEqual({ message: TELEGRAM_INGRESS_MESSAGE_CONCURRENCY, callback_query: TELEGRAM_INGRESS_CALLBACK_CONCURRENCY });
    expect(repository.renewLease).toHaveBeenCalledTimes(2);
    expect(repository.fail).toHaveBeenCalledTimes(failure === "none" ? 0 : 1);
    expect(dispatched.includes(ordinary)).toBe(failure !== "lease");
  });
  it("processes four private buttons before a slow group finishes without overtaking either queue", async () => {
    const items = [
      { id: 1, chat: -100, status: "pending" }, { id: 2, chat: -100, status: "pending" },
      ...[3, 4, 5, 6].map(id => ({ id, chat: 101, status: "pending" })),
    ];
    const finish = async (id: string) => { items.find((item) => String(item.id) === id)!.status = "completed"; };
    const cursors = new Map<string, number>();
    const repository = {
      claimNext: vi.fn(async () => {
        const item = items.find((candidate) => candidate.status === "pending" && !items.some((earlier) =>
          earlier.chat === candidate.chat && earlier.id < candidate.id && earlier.status !== "completed"));
        if (!item) return null;
        item.status = "processing";
        const message = { message_id: item.id, date: 1700000000,
          chat: { id: item.chat, type: item.chat > 0 ? "private" : "group" },
          from: { id: 101, first_name: "Owner", is_bot: false }, text: "request" };
        return { updateId: String(item.id), queueId: String(item.chat), leaseToken: `lease-${item.id}`,
          leaseExpiresAt: new Date(Date.now() + 60_000), attemptCount: 1,
          deliveryContinuationKey: `${item.chat}::`, ingressContinuationKey: `${item.chat}::`,
          voice: null, transcript: null, payload: { update_id: item.id,
            ...(item.chat > 0 ? { callback_query: {
              id: `callback-${item.id}`, chat_instance: "chat", data: `eve:${item.id}`,
              from: message.from, message,
            } } : { message }) },
        };
      }),
      beginDispatch: vi.fn(), complete: vi.fn(finish),
      completeWithSession: vi.fn(async (id: string, _lease: string, sessionId: string, next: number) => {
        cursors.set(sessionId, next);
        await finish(id);
      }),
      sessionEventStreamCursor: vi.fn(async (id: string) => cursors.get(id) ?? 0), fail: vi.fn(), renewLease: vi.fn(),
      acceptMedia: vi.fn(), beginVoiceTranscription: vi.fn(), enqueue: vi.fn(),
      rekeyQueue: vi.fn(), release: vi.fn(), saveVoiceTranscript: vi.fn(),
    } satisfies TelegramIngressRepository;
    let releaseGroup!: () => void;
    let releasePrivate!: () => void;
    const groupGate = new Promise<void>((resolve) => { releaseGroup = resolve; });
    const privateGate = new Promise<void>((resolve) => { releasePrivate = resolve; });
    const dispatched: number[] = [];
    const streamStarts: number[][] = [];
    const handler = createTelegramDurableIngress({ repository, botUsername: "osinara_bot",
      leaseMilliseconds: 60_000, acceptMedia: vi.fn(), authorizeVoice: vi.fn(),
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false), transcribeVoice: vi.fn(),
    });
    const work: Promise<unknown>[] = [];
    async function drain() {
      await handler.drain({ notifyTimeout: vi.fn(), waitUntil: (task) => { work.push(task); }, dispatch: correlatedDispatch(async (update) => {
        const id = Number(update.kind === "message" ? update.message.messageId : update.callbackQuery.message!.messageId);
        dispatched.push(id);
        return { id: id > 2 ? "private-session" : "group-session", getEventStream: async ({ startIndex }: { startIndex: number }) => {
          streamStarts.push([id, startIndex]);
          return new ReadableStream({
            async start(controller) {
              if (id === 1) await groupGate;
              if (id === 3) await privateGate;
              controller.enqueue({ type: "session.waiting" }); controller.close();
            },
          });
        } } as never;
      }) });
    }
    try {
      await drain();
      await vi.waitFor(() => expect(dispatched).toEqual([1]));
      await drain();
      await vi.waitFor(() => expect(dispatched).toEqual([1, 3]));
      await drain();
      await Promise.resolve();
      expect(dispatched).toEqual([1, 3]);
      releasePrivate();
      await vi.waitFor(() => expect(items[5]!.status).toBe("completed"));
      expect(items[0]!.status).toBe("processing");
      expect(dispatched).toEqual([1, 3, 4, 5, 6]);
    } finally {
      releasePrivate(); releaseGroup();
      await Promise.all(work);
    }
    expect(dispatched).toEqual([1, 3, 4, 5, 6, 2]);
    expect(streamStarts).toEqual([[1, 0], [3, 0], [4, 1], [5, 2], [6, 3], [2, 1]]);
    expect(repository.fail).not.toHaveBeenCalled();
  });
});
