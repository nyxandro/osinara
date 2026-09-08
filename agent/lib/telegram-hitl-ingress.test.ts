/** Native HITL callbacks resume their verified session instead of being dropped as unknown buttons. */
import { describe, expect, it, vi } from "vitest";
import { TELEGRAM_HITL_CALLBACK_PREFIX } from "eve/channels/telegram";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { correlatedDispatch } from "./telegram-ingress.test-fixtures.js";

function fixture(count: number) {
  const claims = Array.from({ length: count }, (_, index) => ({
    dispatchStarted: false, dispatchBinding: null,
    recoveryCancelRequested: false,
    attemptCount: 1, deliveryContinuationKey: "101::", ingressContinuationKey: "101::",
    leaseExpiresAt: new Date(Date.now() + 60_000), leaseToken: `lease-${index}`, queueId: "queue",
    updateId: String(1001 + index), transcript: null, voice: null,
    payload: {
      update_id: 1001 + index,
      callback_query: {
        id: `callback-${index}`, chat_instance: "chat",
        data: `${TELEGRAM_HITL_CALLBACK_PREFIX}${index}`,
        from: { id: 101, first_name: "Owner", is_bot: false },
        message: { message_id: 700 + index, date: 1_700_000_000, chat: { id: 101, type: "private" } },
      },
    },
  }));
  const repository = {
    acceptMedia: vi.fn(), beginDispatch: vi.fn(), beginVoiceTranscription: vi.fn(),
    claimNext: vi.fn(async () => claims.shift() ?? null), complete: vi.fn(),
    completeWithSession: vi.fn(), enqueue: vi.fn(), fail: vi.fn(), rekeyQueue: vi.fn(),
    release: vi.fn(), renewLease: vi.fn(), saveVoiceTranscript: vi.fn(),
    sessionEventStreamCursor: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(2),
  } satisfies TelegramIngressRepository;
  const dispatch = vi.fn();
  const handler = createTelegramDurableIngress({
    acceptMedia: vi.fn(), authorizeVoice: vi.fn(), botUsername: "osinara_bot",
    handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false), leaseMilliseconds: 1_000,
    repository, transcribeVoice: vi.fn(),
  });
  async function drain() {
    let pending: Promise<unknown> | undefined;
    await handler.drain({ attachSession: vi.fn(), dispatch: correlatedDispatch(dispatch), notifyTimeout: vi.fn(), waitUntil: (task) => { pending = task; } });
    if (!pending) throw new Error("TEST_DRAIN_NOT_SCHEDULED");
    await pending;
  }
  return { repository, dispatch, drain };
}

describe("native Telegram HITL ingress", () => {
  it("dispatches consecutive decisions and advances the resumed session cursor", async () => {
    const { repository, dispatch, drain } = fixture(2);
    const starts: number[] = [];
    dispatch.mockResolvedValue({
      id: "eve-session",
      async getEventStream({ startIndex }: { startIndex: number }) {
        starts.push(startIndex);
        return new ReadableStream({ start(controller) {
          controller.enqueue({ type: "input.resolved" });
          controller.enqueue({ type: "session.waiting" });
          controller.close();
        } });
      },
    });
    await drain();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "callback_query", callbackQuery: expect.objectContaining({ data: "eve:0" }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(repository.beginDispatch).toHaveBeenNthCalledWith(1, "1001", "lease-0", expect.any(String));
    expect(repository.beginDispatch).toHaveBeenNthCalledWith(2, "1002", "lease-1", expect.any(String));
    expect(starts).toEqual([0, 2]);
    expect(repository.completeWithSession).toHaveBeenNthCalledWith(1, "1001", "lease-0", "eve-session", 2);
    expect(repository.completeWithSession).toHaveBeenNthCalledWith(2, "1002", "lease-1", "eve-session", 4);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("does not wait for a session when the native authorizer rejects a stale or foreign button", async () => {
    const { repository, dispatch, drain } = fixture(1);
    dispatch.mockResolvedValue(undefined);
    await drain();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(repository.complete).toHaveBeenCalledWith("1001", "lease-0");
    expect(repository.sessionEventStreamCursor).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("records an ambiguous callback dispatch failure without retrying it or blocking the next callback", async () => {
    const { repository, dispatch, drain } = fixture(2);
    dispatch.mockRejectedValueOnce(new Error("TEST_CALLBACK_DELIVERY_FAILED")).mockResolvedValueOnce(undefined);
    await drain();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(repository.fail).toHaveBeenCalledWith("1001", "lease-0", expect.objectContaining({
      code: "AGENT_TELEGRAM_INGRESS_FAILED",
    }), undefined);
    expect(repository.complete).toHaveBeenCalledWith("1002", "lease-1");
  });
});
