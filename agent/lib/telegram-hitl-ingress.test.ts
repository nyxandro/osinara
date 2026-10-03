/** Runtime HITL callbacks reach their verified session instead of being dropped as unknown buttons. */
import { describe, expect, it, vi } from "vitest";
import { TELEGRAM_HITL_CALLBACK_PREFIX } from "../runtime/telegram/hitl.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";

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
    enqueue: vi.fn(), fail: vi.fn(), rekeyQueue: vi.fn(),
    release: vi.fn(), renewLease: vi.fn(), saveVoiceTranscript: vi.fn(),
    privateBurstReadyIn: vi.fn(async () => null),
  } satisfies TelegramIngressRepository;
  const dispatch = vi.fn();
  const runTurn = vi.fn().mockResolvedValue({ status: "completed", text: "готово" });
  const handler = createTelegramDurableIngress({
    reportFailure: vi.fn(),
    acceptMedia: vi.fn(), authorizeVoice: vi.fn(), botUsername: "osinara_bot", dispatch,
    handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false), leaseMilliseconds: 1_000,
    repository, runTurn, transcribeVoice: vi.fn(),
  });
  async function drain() {
    let pending: Promise<unknown> | undefined;
    await handler.drain({ waitUntil: (task) => { pending = task; } });
    if (!pending) throw new Error("TEST_DRAIN_NOT_SCHEDULED");
    await pending;
  }
  return { dispatch, drain, repository, runTurn };
}

describe("runtime Telegram HITL ingress", () => {
  it("dispatches consecutive decisions and runs each continuation before the next button", async () => {
    const { dispatch, drain, repository, runTurn } = fixture(2);
    dispatch
      .mockResolvedValueOnce({ sessionId: "wrun_session", status: "dispatched", turnId: "turn_waiting" })
      .mockResolvedValueOnce({ sessionId: "wrun_session", status: "dispatched", turnId: "turn_continuation" });
    await drain();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "callback_query", callbackQuery: expect.objectContaining({ data: "hitl:0" }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(repository.beginDispatch).toHaveBeenNthCalledWith(1, "1001", "lease-0", expect.any(String));
    expect(repository.beginDispatch).toHaveBeenNthCalledWith(2, "1002", "lease-1", expect.any(String));
    expect(runTurn.mock.calls).toEqual([["turn_waiting"], ["turn_continuation"]]);
    expect(repository.complete).toHaveBeenNthCalledWith(1, "1001", "lease-0", "wrun_session");
    expect(repository.complete).toHaveBeenNthCalledWith(2, "1002", "lease-1", "wrun_session");
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("runs nothing when the application authorizer rejects a stale or foreign button", async () => {
    const { dispatch, drain, repository, runTurn } = fixture(1);
    dispatch.mockResolvedValue({ status: "dropped" });
    await drain();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(runTurn).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledWith("1001", "lease-0", undefined);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("records a failed callback dispatch without retrying it or blocking the next callback", async () => {
    const { dispatch, drain, repository } = fixture(2);
    dispatch.mockRejectedValueOnce(new Error("TEST_CALLBACK_DELIVERY_FAILED")).mockResolvedValueOnce({ status: "dropped" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await drain();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(repository.fail).toHaveBeenCalledWith("1001", "lease-0", expect.objectContaining({
      code: "AGENT_TELEGRAM_INGRESS_FAILED",
    }), undefined);
    expect(repository.complete).toHaveBeenCalledWith("1002", "lease-1", undefined);
    vi.restoreAllMocks();
  });
});
