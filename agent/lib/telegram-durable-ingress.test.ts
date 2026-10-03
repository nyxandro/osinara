/**
 * Durable Telegram ingress coordinator tests.
 *
 * Constructs covered:
 * - Webhook ACK waits only for persistence, never voice transcription or turn execution.
 * - External media is acknowledged without entering the durable queue or dispatch.
 * - Voice results persist once before dispatch.
 * - Captionless attachments receive a non-empty factual model message after durable storage.
 * - An update completes only after its turn ran to the end, with the session it ran in.
 * - A restarted update that already created its turn lets that turn finish; one interrupted before
 *   its turn existed is prepared again under its own attempt, never dispatched twice.
 * - A preparation that outlives the admission window creates no turn.
 * - An unknown non-HITL callback is never dispatched when no application handler claims it.
 * - One failed item releases its own record and the drain keeps going.
 * - A private chat still receiving a burst is claimed the moment its quiet window ends, not at the
 *   next poll, with the configured window.
 * - A claimed burst is dispatched as one message carrying every part in chat order.
 */
import { parseTelegramUpdate } from "../runtime/telegram/inbound.js";
import type { RouteContext } from "../runtime/server.js";
import type { JsonObject } from "../runtime/json.js";
import { describe, expect, it, vi } from "vitest";

import type { TelegramIngressClaim, TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { createTelegramDurableIngress, type DurableIngressDependencies } from "./telegram-durable-ingress.js";

function voicePayload(): Record<string, unknown> {
  return {
    message: {
      chat: { id: 101, type: "private" },
      date: 1_700_000_000,
      from: { first_name: "Анна", id: 101, is_bot: false },
      message_id: 77,
      voice: {
        file_id: "voice-file-1",
        file_size: 512,
        mime_type: "audio/ogg",
      },
    },
    update_id: 1001,
  };
}

function callbackPayload(): Record<string, unknown> {
  return {
    callback_query: {
      chat_instance: "-100",
      data: "su:x:0123456789abcdef",
      from: { first_name: "Анна", id: 101, is_bot: false },
      id: "callback-1",
      message: {
        chat: { id: 101, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Osinara", id: 900, is_bot: true },
        message_id: 78,
      },
    },
    update_id: 1002,
  };
}

const DISPATCHED = { sessionId: "wrun_session", status: "dispatched", turnId: "turn_one" } as const;

function ingress(
  storage: ReturnType<typeof repository>,
  overrides: Partial<DurableIngressDependencies> = {},
) {
  const dependencies = {
    reportFailure: vi.fn(),
    acceptMedia: vi.fn().mockResolvedValue(true),
    authorizeVoice: vi.fn().mockResolvedValue(true),
    botUsername: "osinara_bot",
    dispatch: vi.fn().mockResolvedValue(DISPATCHED),
    handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
    leaseMilliseconds: 60_000,
    admissionMilliseconds: 60_000,
    repository: storage.value,
    runTurn: vi.fn().mockResolvedValue({ status: "completed", text: "готово" }),
    transcribeVoice: vi.fn().mockResolvedValue("Купи молоко"),
    ...overrides,
  };
  return { dependencies, handle: createTelegramDurableIngress(dependencies) };
}

async function deliver(handle: ReturnType<typeof createTelegramDurableIngress>, raw: Record<string, unknown>) {
  const update = parseTelegramUpdate(raw);
  if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
  let backgroundTask: Promise<unknown> | undefined;
  const context: RouteContext = { waitUntil(task) { backgroundTask = task; } };
  const response = await handle({ ...context, raw: raw as JsonObject, update });
  return { background: backgroundTask, response, update };
}

async function runDrain(handle: ReturnType<typeof createTelegramDurableIngress>, raw: Record<string, unknown>): Promise<void> {
  const { background } = await deliver(handle, raw);
  if (!background) throw new Error("AGENT_TEST_BACKGROUND_TASK_MISSING: Durable ingress did not schedule a drain");
  await background;
}

function repository() {
  const claim: TelegramIngressClaim = {
    dispatchStarted: false,
    dispatchBinding: null,
    attemptCount: 1,
    deliveryContinuationKey: "101::",
    ingressContinuationKey: "101::",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseToken: "123e4567-e89b-42d3-a456-426614174000",
    payload: voicePayload(),
    queueId: "123e4567-e89b-42d3-a456-426614174001",
    transcript: null,
    updateId: "1001",
    voice: { fileId: "voice-file-1", fileSize: 512, mimeType: "audio/ogg" },
  };
  return {
    claim,
    value: {
      acceptMedia: vi.fn().mockResolvedValue(true),
      beginDispatch: vi.fn(),
      beginVoiceTranscription: vi.fn().mockResolvedValue("started"),
      claimNext: vi.fn().mockResolvedValueOnce(claim).mockResolvedValueOnce(null),
      complete: vi.fn(),
      enqueue: vi.fn().mockResolvedValue("inserted"),
      fail: vi.fn(),
      rekeyQueue: vi.fn(),
      release: vi.fn(),
      renewLease: vi.fn(),
      saveVoiceTranscript: vi.fn(),
      privateBurstReadyIn: vi.fn().mockResolvedValue(null),
    } satisfies TelegramIngressRepository,
  };
}

describe("createTelegramDurableIngress", () => {
  it("acknowledges after enqueue, then transcribes the voice once and runs its turn to the end", async () => {
    const storage = repository();
    const order: string[] = [];
    const { dependencies, handle } = ingress(storage, {
      dispatch: vi.fn(async () => { order.push("dispatch"); return DISPATCHED; }),
      runTurn: vi.fn(async () => { order.push("turn"); return { status: "completed" as const, text: "готово" }; }),
    });
    storage.value.complete.mockImplementation(async () => { order.push("complete"); });

    const { background, response } = await deliver(handle, voicePayload());

    expect(response.status).toBe(200);
    expect(storage.value.enqueue).toHaveBeenCalledTimes(1);
    expect(dependencies.transcribeVoice).not.toHaveBeenCalled();
    await background;
    expect(dependencies.transcribeVoice).toHaveBeenCalledTimes(1);
    expect(storage.value.beginVoiceTranscription).toHaveBeenCalledWith("1001", storage.claim.leaseToken);
    expect(storage.value.saveVoiceTranscript).toHaveBeenCalledWith("1001", storage.claim.leaseToken, "Купи молоко");
    const [update, control] = vi.mocked(dependencies.dispatch).mock.calls[0]!;
    expect(update).toMatchObject({ message: { text: "Купи молоко" } });
    expect(control.attributes).toEqual({
      osinaraTelegramDeadlineAt: expect.any(String),
      osinaraTelegramIngressId: vi.mocked(storage.value.beginDispatch).mock.calls[0]![2],
      osinaraTelegramUpdateId: "1001",
    });
    expect(dependencies.runTurn).toHaveBeenCalledWith("turn_one");
    expect(order).toEqual(["dispatch", "turn", "complete"]);
    expect(storage.value.complete).toHaveBeenCalledWith("1001", storage.claim.leaseToken, "wrun_session");
  });

  it("lets the turn of a restarted update finish without dispatching the update again", async () => {
    const storage = repository();
    storage.value.claimNext = vi.fn()
      .mockResolvedValueOnce({
        ...storage.claim, dispatchAttemptId: "attempt-1", dispatchBinding: { id: "attempt-1", sessionId: "wrun_session", turnId: "turn_bound" },
        dispatchStarted: true, recoveryProtocol: 1, transcript: "Купи молоко",
      })
      .mockResolvedValueOnce(null);
    const { dependencies, handle } = ingress(storage);

    await runDrain(handle, voicePayload());

    expect(dependencies.runTurn).toHaveBeenCalledWith("turn_bound");
    expect(dependencies.dispatch).not.toHaveBeenCalled();
    expect(dependencies.transcribeVoice).not.toHaveBeenCalled();
    expect(storage.value.beginDispatch).not.toHaveBeenCalled();
    expect(storage.value.complete).toHaveBeenCalledWith("1001", storage.claim.leaseToken, "wrun_session");
  });

  it("prepares again, under its own attempt, an update interrupted before its turn existed", async () => {
    const storage = repository();
    storage.value.claimNext = vi.fn()
      .mockResolvedValueOnce({ ...storage.claim, dispatchAttemptId: "attempt-1", dispatchStarted: true, recoveryProtocol: 1, transcript: "Купи молоко" })
      .mockResolvedValueOnce(null);
    const { dependencies, handle } = ingress(storage);

    await runDrain(handle, voicePayload());

    expect(storage.value.beginDispatch).not.toHaveBeenCalled();
    expect(dependencies.transcribeVoice).not.toHaveBeenCalled();
    const [, control] = vi.mocked(dependencies.dispatch).mock.calls[0]!;
    expect(control.attributes?.osinaraTelegramIngressId).toBe("attempt-1");
    expect(dependencies.runTurn).toHaveBeenCalledWith("turn_one");
  });

  it("creates no turn when the preparation outlives the admission window", async () => {
    const storage = repository();
    const { dependencies, handle } = ingress(storage, {
      admissionMilliseconds: 20,
      dispatch: vi.fn(async (_update, control) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        control.signal?.throwIfAborted();
        return DISPATCHED;
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runDrain(handle, voicePayload());

    expect(dependencies.runTurn).not.toHaveBeenCalled();
    expect(storage.value.fail.mock.calls[0]?.[2]).toMatchObject({ code: "AGENT_TELEGRAM_PROCESSING_TIMEOUT" });
    vi.restoreAllMocks();
  });

  it("never dispatches an unknown non-HITL callback when no handler claims it", async () => {
    const storage = repository();
    storage.value.claimNext = vi.fn()
      .mockResolvedValueOnce({ ...storage.claim, payload: callbackPayload(), updateId: "1002", voice: null })
      .mockResolvedValueOnce(null);
    const handleSoftwareUpdateCallback = vi.fn().mockResolvedValue(false);
    const { dependencies, handle } = ingress(storage, { handleSoftwareUpdateCallback });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runDrain(handle, callbackPayload());

    expect(handleSoftwareUpdateCallback).toHaveBeenCalledTimes(1);
    expect(dependencies.dispatch).not.toHaveBeenCalled();
    expect(storage.value.beginDispatch).not.toHaveBeenCalled();
    expect(storage.value.complete).toHaveBeenCalledWith("1002", storage.claim.leaseToken, undefined);
    vi.restoreAllMocks();
  });

  it("claims a private chat the moment its burst window ends", async () => {
    const storage = repository();
    storage.value.claimNext = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(storage.claim)
      .mockResolvedValueOnce(null);
    storage.value.privateBurstReadyIn = vi.fn().mockResolvedValueOnce(30).mockResolvedValue(null);
    const { dependencies, handle } = ingress(storage);

    await runDrain(handle, voicePayload());

    expect(dependencies.dispatch).toHaveBeenCalledTimes(1);
    expect(storage.value.claimNext).toHaveBeenCalledWith(60_000, { maxCharacters: 6_000, maxMessages: 10, maxWaitMilliseconds: 20_000, quietMilliseconds: 2_000 });
    expect(storage.value.privateBurstReadyIn).toHaveBeenCalledWith({ maxCharacters: 6_000, maxMessages: 10, maxWaitMilliseconds: 20_000, quietMilliseconds: 2_000 });
  });

  it("dispatches a claimed burst as one message with every part in order", async () => {
    const storage = repository();
    const part = (id: number, text: string) => ({
      message: { chat: { id: 101, type: "private" }, date: 1_700_000_000, from: { first_name: "Анна", id: 101, is_bot: false }, message_id: id, text },
      update_id: id,
    });
    const burst = [part(1101, "напомни завтра в 9 позвонить маме"), part(1102, "и добавь молоко в список"), part(1103, "спасибо")];
    storage.value.claimNext = vi.fn()
      .mockResolvedValueOnce({ ...storage.claim, burstPayloads: burst, payload: burst[0], updateId: "1101", voice: null })
      .mockResolvedValueOnce(null);
    const { dependencies, handle } = ingress(storage);

    await runDrain(handle, voicePayload());

    const [update] = vi.mocked(dependencies.dispatch).mock.calls[0]!;
    if (update.kind !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
    expect(update.message.messageId).toBe("1101");
    expect(update.message.text).toBe("напомни завтра в 9 позвонить маме\n\nи добавь молоко в список\n\nспасибо");
  });

  it("keeps draining the queue after one item fails", async () => {
    const storage = repository();
    const second = { ...storage.claim, updateId: "1003" };
    storage.value.claimNext = vi.fn()
      .mockResolvedValueOnce(storage.claim)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(null);
    const { dependencies, handle } = ingress(storage, {
      dispatch: vi.fn().mockRejectedValueOnce(new Error("dispatch exploded")).mockResolvedValueOnce({ ...DISPATCHED, sessionId: "wrun_second" }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runDrain(handle, voicePayload());

    expect(storage.value.fail).toHaveBeenCalledTimes(1);
    expect(storage.value.fail.mock.calls[0]?.[0]).toBe("1001");
    expect(dependencies.dispatch).toHaveBeenCalledTimes(2);
    expect(storage.value.complete).toHaveBeenCalledWith("1003", second.leaseToken, "wrun_second");
    vi.restoreAllMocks();
  });

  it("acknowledges rejected external media without enqueue, download, or dispatch", async () => {
    const storage = repository();
    storage.value.claimNext.mockReset().mockResolvedValue(null);
    const acceptMedia = vi.fn().mockResolvedValue(false);
    const { dependencies, handle } = ingress(storage, { acceptMedia });
    const raw = voicePayload();
    (raw.message as Record<string, unknown>).chat = { id: -1001, type: "supergroup" };

    const { background, response, update } = await deliver(handle, raw);

    expect(response.status).toBe(200);
    if (update.kind !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
    expect(acceptMedia).toHaveBeenCalledWith(update.message, "1001", "unsupported_media");
    expect(storage.value.enqueue).not.toHaveBeenCalled();
    expect(dependencies.transcribeVoice).not.toHaveBeenCalled();
    expect(dependencies.dispatch).not.toHaveBeenCalled();
    expect(background).toBeUndefined();
  });

  it("dispatches a captionless photo with a non-empty factual model message", async () => {
    const storage = repository();
    const raw = {
      message: {
        chat: { id: 101, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Анна", id: 101, is_bot: false },
        message_id: 78,
        photo: [{ file_id: "photo-file-1", file_size: 1_024, file_unique_id: "photo-unique-1", height: 640, width: 640 }],
      },
      update_id: 1002,
    };
    Object.assign(storage.claim, { payload: raw, updateId: "1002", voice: null });
    const { dependencies, handle } = ingress(storage, { dispatch: vi.fn().mockResolvedValue({ status: "dropped" }) });

    await runDrain(handle, raw);

    expect(vi.mocked(dependencies.dispatch).mock.calls[0]?.[0]).toMatchObject({
      kind: "message",
      message: {
        attachments: [expect.objectContaining({ fileId: "photo-file-1", kind: "photo" })],
        text: "Пользователь отправил файл без подписи.",
      },
    });
    expect((raw.message as Record<string, unknown>).text).toBeUndefined();
    expect(dependencies.runTurn).not.toHaveBeenCalled();
  });
});
