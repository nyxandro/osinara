/**
 * Durable Telegram ingress coordinator tests.
 *
 * Constructs covered:
 * - Webhook ACK waits only for persistence, never voice transcription or Eve execution.
 * - External media is acknowledged without entering the durable queue or native dispatch.
 * - Voice results persist once before native Eve dispatch.
 * - Captionless attachments receive a non-empty factual model message after durable storage.
 * - FIFO releases at a waiting boundary even though the durable session stream remains open.
 * - Reused Eve sessions start at the persisted stream cursor and ignore an old waiting boundary.
 * - An unknown non-HITL callback never reaches Eve when no application handler claims it.
 * - One failed item releases its own record and the drain keeps going.
 * - A session that never reaches a boundary releases the queue within one lease.
 */
import type { TelegramVerifiedUpdateContext } from "eve/channels/telegram";
import { parseTelegramUpdate } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { correlatedDispatch } from "./telegram-ingress.test-fixtures.js";

const BOUNDARY_SETTLEMENT_TIMEOUT_MILLISECONDS = 100;

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

function ingress(
  storage: ReturnType<typeof repository>,
  overrides: {
    dispatch: ReturnType<typeof vi.fn>;
    handleSoftwareUpdateCallback?: () => Promise<boolean>;
    leaseMilliseconds?: number;
  },
) {
  return createTelegramDurableIngress({
    acceptMedia: vi.fn().mockResolvedValue(true),
    authorizeVoice: vi.fn().mockResolvedValue(true),
    botUsername: "osinara_bot",
    handleSoftwareUpdateCallback:
      overrides.handleSoftwareUpdateCallback ?? vi.fn().mockResolvedValue(false),
    leaseMilliseconds: overrides.leaseMilliseconds ?? 60_000,
    admissionMilliseconds: overrides.leaseMilliseconds ?? 60_000,
    observerIdleMilliseconds: overrides.leaseMilliseconds ?? 60_000,
    cancellationMilliseconds: 20,
    repository: storage.value,
    transcribeVoice: vi.fn().mockResolvedValue("Купи молоко"),
  });
}

async function runDrain(
  handle: ReturnType<typeof createTelegramDurableIngress>,
  raw: Record<string, unknown>,
  dispatch: ReturnType<typeof vi.fn>,
): Promise<void> {
  const update = parseTelegramUpdate(raw);
  if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
  let backgroundTask: Promise<unknown> | undefined;
  await handle({
    dispatch: correlatedDispatch(dispatch as TelegramVerifiedUpdateContext["dispatch"]),
    notifyTimeout: vi.fn(),
    raw,
    update,
    waitUntil(task) {
      backgroundTask = task;
    },
  } as TelegramVerifiedUpdateContext);
  if (!backgroundTask) {
    throw new Error("AGENT_TEST_BACKGROUND_TASK_MISSING: Durable ingress did not schedule a drain");
  }
  await backgroundTask;
}

function repository() {
  const claim = {
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
      completeWithSession: vi.fn(),
      enqueue: vi.fn().mockResolvedValue("inserted"),
      fail: vi.fn(),
      rekeyQueue: vi.fn(),
      release: vi.fn(),
      renewLease: vi.fn(),
      sessionEventStreamCursor: vi.fn().mockResolvedValue(0),
      saveVoiceTranscript: vi.fn(),
    } satisfies TelegramIngressRepository,
  };
}

describe("createTelegramDurableIngress", () => {
  it("acknowledges after enqueue and processes voice in the background", async () => {
    const storage = repository();
    const transcribeVoice = vi.fn().mockResolvedValue("Купи молоко");
    let sessionStreamController: ReadableStreamDefaultController<{ type: string }> | undefined;
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async () =>
        new ReadableStream({
          start(controller) {
            sessionStreamController = controller;
            controller.enqueue({ type: "session.waiting" });
          },
        }),
      id: "session-1",
    });
    let backgroundTask: Promise<unknown> | undefined;
    const raw = voicePayload();
    const update = parseTelegramUpdate(raw);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn().mockResolvedValue(true),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      transcribeVoice,
    });

    const response = await handle({
      dispatch: correlatedDispatch(dispatch),
      notifyTimeout: vi.fn(),
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);

    expect(response.status).toBe(200);
    expect(storage.value.enqueue).toHaveBeenCalledTimes(1);
    expect(transcribeVoice).not.toHaveBeenCalled();
    if (!backgroundTask) {
      throw new Error("AGENT_TEST_BACKGROUND_TASK_MISSING: Durable ingress did not schedule a drain");
    }

    // Eve keeps the durable stream open for future turns, so waiting must itself settle the drain.
    const settledAtBoundary = await Promise.race([
      backgroundTask.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), BOUNDARY_SETTLEMENT_TIMEOUT_MILLISECONDS);
      }),
    ]);
    if (!settledAtBoundary) {
      sessionStreamController?.close();
      await backgroundTask;
    }

    expect(settledAtBoundary).toBe(true);
    expect(transcribeVoice).toHaveBeenCalledTimes(1);
    expect(storage.value.beginVoiceTranscription).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
    );
    expect(storage.value.saveVoiceTranscript).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
      "Купи молоко",
    );
    expect(dispatch.mock.calls[0]?.[0].message.text).toBe("Купи молоко");
    expect(storage.value.beginDispatch).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
    );
    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
      "session-1",
      1,
    );
  });

  it("does not let an old session.waiting complete a newly dispatched turn", async () => {
    const storage = repository();
    storage.value.sessionEventStreamCursor.mockResolvedValue(2);
    const requestedStartIndexes: number[] = [];
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async (options?: { startIndex?: number }) => {
        requestedStartIndexes.push(options?.startIndex ?? 0);
        return new ReadableStream({
          start(controller) {
            // The old waiting event is at index 1 and must be excluded by startIndex=2.
            controller.enqueue({ type: "turn.started" });
            controller.enqueue({ type: "turn.completed" });
            controller.enqueue({ type: "session.waiting" });
          },
        });
      },
      id: "session-reused",
    });
    const raw = voicePayload();
    const update = parseTelegramUpdate(raw);
    if (!update) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn().mockResolvedValue(false),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      transcribeVoice: vi.fn(),
    });
    let backgroundTask: Promise<unknown> | undefined;

    await handle({
      dispatch: correlatedDispatch(dispatch),
      notifyTimeout: vi.fn(),
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    await backgroundTask;

    expect(requestedStartIndexes).toEqual([2]);
    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1001",
      storage.claim.leaseToken,
      "session-reused",
      5,
    );
  });

  it("never sends an unknown non-HITL callback to Eve when no handler claims it", async () => {
    const storage = repository();
    storage.value.claimNext = vi.fn()
      .mockResolvedValueOnce({
        ...storage.claim,
        payload: callbackPayload(),
        updateId: "1002",
        voice: null,
      })
      .mockResolvedValueOnce(null);
    const dispatch = vi.fn();
    const handleSoftwareUpdateCallback = vi.fn().mockResolvedValue(false);

    await runDrain(
      ingress(storage, { dispatch, handleSoftwareUpdateCallback }),
      callbackPayload(),
      dispatch,
    );

    expect(handleSoftwareUpdateCallback).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(storage.value.beginDispatch).not.toHaveBeenCalled();
    expect(storage.value.complete).toHaveBeenCalledWith("1002", storage.claim.leaseToken);
  });

  it("keeps draining the queue after one item fails", async () => {
    const storage = repository();
    const second = { ...storage.claim, updateId: "1003" };
    storage.value.claimNext = vi.fn()
      .mockResolvedValueOnce(storage.claim)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(null);
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new Error("Eve dispatch exploded"))
      .mockResolvedValueOnce({
        getEventStream: async () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "session.waiting" });
            },
          }),
        id: "session-2",
      });

    await runDrain(ingress(storage, { dispatch }), voicePayload(), dispatch);

    expect(storage.value.fail).toHaveBeenCalledTimes(1);
    expect(storage.value.fail.mock.calls[0]?.[0]).toBe("1001");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(storage.value.completeWithSession).toHaveBeenCalledWith(
      "1003",
      second.leaseToken,
      "session-2",
      1,
    );
  });

  it("quarantines the affected queue when a session cannot confirm stopping", async () => {
    const storage = repository();
    const dispatch = vi.fn().mockResolvedValue({
      getEventStream: async () => new ReadableStream({ start() {} }),
      id: "session-3",
    });

    await runDrain(ingress(storage, { dispatch, leaseMilliseconds: 60 }), voicePayload(), dispatch);

    expect(storage.value.completeWithSession).not.toHaveBeenCalled();
    expect(storage.value.fail).toHaveBeenCalledTimes(1);
    expect(storage.value.fail.mock.calls[0]?.[2]).toMatchObject({
      code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED",
    });
  });

  it.each(["open", "cancel"] as const)("does not block later messages when stream %s hangs", async (phase) => {
    const storage = repository();
    storage.value.claimNext = vi.fn()
      .mockResolvedValueOnce(storage.claim)
      .mockResolvedValueOnce({ ...storage.claim, updateId: "1003" })
      .mockResolvedValueOnce(null);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const cancel = vi.fn(async () => { if (phase === "cancel") await blocked; });
    const dispatch = vi.fn().mockResolvedValueOnce({
      id: "session-stuck",
      async getEventStream() {
        if (phase === "open") await blocked;
        return new ReadableStream({
          start(controller) { controller.enqueue({ type: "session.waiting" }); },
          cancel,
        });
      },
    }).mockResolvedValueOnce(null);
    const running = runDrain(ingress(storage, { dispatch, leaseMilliseconds: 60 }), voicePayload(), dispatch);
    const settled = await Promise.race([
      running.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => resolve(false), 180); }),
    ]);
    unblock();
    await running;
    expect(settled).toBe(true);
    if (phase === "open") {
      expect(storage.value.fail.mock.calls[0]?.[2]).toMatchObject({ code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED" });
    } else {
      expect(storage.value.fail).not.toHaveBeenCalled();
      expect(storage.value.completeWithSession).toHaveBeenCalledWith("1001", storage.claim.leaseToken, "session-stuck", 1);
    }
    expect(storage.value.complete).toHaveBeenCalledWith("1003", storage.claim.leaseToken);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(phase === "open" ? 2 : 1));
  });

  it("acknowledges rejected external media without enqueue, download, or dispatch", async () => {
    const storage = repository();
    storage.value.claimNext.mockReset().mockResolvedValue(null);
    const acceptMedia = vi.fn().mockResolvedValue(false);
    const transcribeVoice = vi.fn();
    const dispatch = vi.fn();
    const waitUntil = vi.fn();
    const raw = voicePayload();
    const rawMessage = raw.message as Record<string, unknown>;
    rawMessage.chat = { id: -1001, type: "supergroup" };
    const update = parseTelegramUpdate(raw);
    if (!update || update.kind !== "message") {
      throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое сообщение");
    }
    const handle = createTelegramDurableIngress({
      acceptMedia,
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      transcribeVoice,
    });

    const response = await handle({ dispatch, notifyTimeout: vi.fn(), raw, update, waitUntil } as TelegramVerifiedUpdateContext);

    expect(response.status).toBe(200);
    expect(acceptMedia).toHaveBeenCalledWith(update.message, "1001", "unsupported_media");
    expect(storage.value.enqueue).not.toHaveBeenCalled();
    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("dispatches a captionless photo with a non-empty factual model message", async () => {
    const storage = repository();
    const raw = {
      message: {
        chat: { id: 101, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Анна", id: 101, is_bot: false },
        message_id: 78,
        photo: [{
          file_id: "photo-file-1",
          file_size: 1_024,
          file_unique_id: "photo-unique-1",
          height: 640,
          width: 640,
        }],
      },
      update_id: 1002,
    };
    Object.assign(storage.claim, { payload: raw, updateId: "1002", voice: null });
    const update = parseTelegramUpdate(raw);
    if (!update || update.kind !== "message") {
      throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое сообщение");
    }
    const dispatch = vi.fn().mockResolvedValue(null);
    let backgroundTask: Promise<unknown> | undefined;
    const handle = createTelegramDurableIngress({
      acceptMedia: vi.fn().mockResolvedValue(true),
      authorizeVoice: vi.fn(),
      botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn().mockResolvedValue(false),
      leaseMilliseconds: 60_000,
      repository: storage.value,
      transcribeVoice: vi.fn(),
    });

    await handle({
      dispatch: correlatedDispatch(dispatch),
      notifyTimeout: vi.fn(),
      raw,
      update,
      waitUntil(task) {
        backgroundTask = task;
      },
    } as TelegramVerifiedUpdateContext);
    if (!backgroundTask) {
      throw new Error("AGENT_TEST_BACKGROUND_TASK_MISSING: Durable ingress did not schedule a drain");
    }
    await backgroundTask;

    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: "message",
      message: {
        attachments: [expect.objectContaining({ fileId: "photo-file-1", kind: "photo" })],
        text: "Пользователь отправил файл без подписи.",
      },
    });
    expect((raw.message as Record<string, unknown>).text).toBeUndefined();
  });
});
