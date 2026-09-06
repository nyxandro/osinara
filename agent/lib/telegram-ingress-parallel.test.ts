/** A slow group must not block private approval buttons; each chat still has one FIFO head. */
import { describe, expect, it, vi } from "vitest";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";

describe("independent Telegram queue progress", () => {
  it("processes four private buttons before a slow group finishes without overtaking either queue", async () => {
    const items = [
      { id: 1, chat: -100, status: "pending" }, { id: 2, chat: -100, status: "pending" },
      ...[3, 4, 5, 6].map(id => ({ id, chat: 101, status: "pending" })),
    ];
    const finish = async (id: string) => { items.find(item => String(item.id) === id)!.status = "completed"; };
    const cursors = new Map<string, number>();
    const repository = {
      claimNext: vi.fn(async () => {
        const item = items.find(candidate => candidate.status === "pending" && !items.some(earlier =>
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
            ...(item.chat > 0 ? { callback_query: { id: `callback-${item.id}`, chat_instance: "chat",
              data: `eve:${item.id}`, from: message.from, message } } : { message }) },
        };
      }),
      beginDispatch: vi.fn(), complete: vi.fn(finish),
      completeWithSession: vi.fn(async (id: string, _lease: string, sessionId: string, next: number) => {
        cursors.set(sessionId, next); await finish(id);
      }),
      sessionEventStreamCursor: vi.fn(async (id: string) => cursors.get(id) ?? 0), fail: vi.fn(), renewLease: vi.fn(),
      acceptMedia: vi.fn(), beginVoiceTranscription: vi.fn(), enqueue: vi.fn(),
      rekeyQueue: vi.fn(), release: vi.fn(), saveVoiceTranscript: vi.fn(),
    } satisfies TelegramIngressRepository;
    let releaseGroup!: () => void, releasePrivate!: () => void;
    const groupGate = new Promise<void>(resolve => { releaseGroup = resolve; });
    const privateGate = new Promise<void>(resolve => { releasePrivate = resolve; });
    const dispatched: number[] = [], streamStarts: number[][] = [];
    const handler = createTelegramDurableIngress({ repository, botUsername: "osinara_bot",
      leaseMilliseconds: 60_000, acceptMedia: vi.fn(), authorizeVoice: vi.fn(),
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false), transcribeVoice: vi.fn(),
    });
    const work: Promise<unknown>[] = [];
    async function drain() {
      await handler.drain({ waitUntil: task => { work.push(task); }, dispatch: async update => {
        const id = Number(update.kind === "message" ? update.message.messageId : update.callbackQuery.message!.messageId);
        dispatched.push(id);
        return { id: id > 2 ? "private-session" : "group-session", getEventStream: async ({ startIndex }: { startIndex: number }) => {
          streamStarts.push([id, startIndex]);
          return new ReadableStream({ async start(controller) {
            if (id === 1) await groupGate;
            if (id === 3) await privateGate;
            controller.enqueue({ type: "session.waiting" }); controller.close();
          } });
        } } as never;
      } });
    }
    try {
      await drain(); await vi.waitFor(() => expect(dispatched).toEqual([1]));
      await drain(); await vi.waitFor(() => expect(dispatched).toEqual([1, 3]));
      await drain(); await Promise.resolve(); expect(dispatched).toEqual([1, 3]);
      releasePrivate();
      await vi.waitFor(() => expect(items[5]!.status).toBe("completed"));
      expect(items[0]!.status).toBe("processing");
      expect(dispatched).toEqual([1, 3, 4, 5, 6]);
    } finally { releasePrivate(); releaseGroup(); await Promise.all(work); }
    expect(dispatched).toEqual([1, 3, 4, 5, 6, 2]);
    expect(streamStarts).toEqual([[1, 0], [3, 0], [4, 1], [5, 2], [6, 3], [2, 1]]);
    expect(repository.fail).not.toHaveBeenCalled();
  });
});
