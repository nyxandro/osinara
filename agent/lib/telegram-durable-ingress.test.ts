/**
 * Durable Telegram ingress coordinator tests.
 *
 * Constructs covered:
 * - Webhook ACK waits only for persistence, never voice transcription or Eve execution.
 * - External media is acknowledged without entering the durable queue or native dispatch.
 * - Voice results persist once before native Eve dispatch.
 * - Captionless attachments receive a non-empty factual model message after durable storage.
 * - FIFO releases at a waiting boundary even though the durable session stream remains open.
 */
import type { TelegramVerifiedUpdateContext } from "eve/channels/telegram";
import { parseTelegramUpdate } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";

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
      dispatch,
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
    );
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

    const response = await handle({ dispatch, raw, update, waitUntil } as TelegramVerifiedUpdateContext);

    expect(response.status).toBe(200);
    expect(acceptMedia).toHaveBeenCalledWith(update.message, "1001");
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
      dispatch,
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
