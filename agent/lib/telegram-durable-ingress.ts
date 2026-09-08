/**
 * Durable Telegram ingress coordinator.
 *
 * Exports:
 * - `createTelegramDurableIngress`: verified Eve hook that persists before ACK and drains FIFO.
 * - `handleTelegramDurableIngress`: production hook with PostgreSQL and Groq dependencies.
 * - Application software-update callbacks complete before native Eve dispatch begins.
 */
import type {
  TelegramDrainContext,
  TelegramMessage,
  TelegramUpdate,
  TelegramVerifiedUpdateContext,
} from "eve/channels/telegram";
import {
  parseTelegramUpdate,
  telegramContinuationToken,
  TELEGRAM_HITL_CALLBACK_PREFIX,
} from "eve/channels/telegram";
import { z } from "zod";
import { Sema } from "async-sema";

import {
  TELEGRAM_INGRESS_CALLBACK_CONCURRENCY,
  TELEGRAM_INGRESS_CANCELLATION_GRACE_MS,
  TELEGRAM_INGRESS_ADMISSION_TIMEOUT_MS,
  TELEGRAM_INGRESS_OBSERVER_IDLE_MS,
  TELEGRAM_INGRESS_LEASE_MS,
  TELEGRAM_INGRESS_MESSAGE_CONCURRENCY,
} from "../config.js";
import { AppError, isAppError } from "./app-error.js";
import { transcribeTelegramVoice } from "./groq-voice-transcription.js";
import { type TelegramIngressRepository } from "./telegram-ingress-contract.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import {
  classifyTelegramInboundMedia,
  isMessageAddressedToBot,
  type TelegramInboundMediaKind,
} from "./telegram-message-policy.js";
import { createTelegramVoiceAuthorizer } from "./telegram-voice-authorization.js";
import { telegramRepository } from "./telegram-repository.js";
import { handleSoftwareUpdateCallback } from "./software-updates/callback.js";
import { waitForSessionBoundary } from "./telegram-session-boundary.js";
import { runTelegramProcessing, TelegramProcessingTimeout } from "./telegram-processing-deadline.js";
import { recoverTelegramIngress } from "./telegram-ingress-recovery.js";

const telegramUpdateIdSchema = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/)]);
const telegramVoiceSchema = z.object({
  message: z
    .object({
      voice: z.object({
        file_id: z.string().min(1),
        file_size: z.number().int().positive().optional(),
        mime_type: z.string().min(1).optional(),
      }),
    })
    .passthrough(),
  update_id: telegramUpdateIdSchema,
});

interface DurableIngressDependencies {
  acceptMedia(
    message: Pick<TelegramMessage, "chat">,
    updateId: string,
    mediaKind: Exclude<TelegramInboundMediaKind, "none">,
  ): Promise<boolean>;
  authorizeVoice(message: Pick<TelegramMessage, "chat" | "from">): Promise<boolean>;
  botUsername: string;
  handleSoftwareUpdateCallback(
    query: Extract<TelegramUpdate, { kind: "callback_query" }>["callbackQuery"],
  ): Promise<boolean>;
  leaseMilliseconds: number;
  admissionMilliseconds?: number;
  observerIdleMilliseconds?: number;
  cancellationMilliseconds?: number;
  repository: TelegramIngressRepository;
  transcribeVoice(input: {
    fileId: string;
    fileSize?: number;
    mimeType?: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

interface TelegramDurableIngressHandler {
  (context: TelegramVerifiedUpdateContext): Promise<Response>;
  drain(context: TelegramDrainContext): Promise<Response>;
}

const LEASE_HEARTBEAT_DIVISOR = 3;
const CAPTIONLESS_ATTACHMENT_MODEL_TEXT = "Пользователь отправил файл без подписи.";

function updateId(raw: Record<string, unknown>): string {
  const parsed = telegramUpdateIdSchema.safeParse(raw.update_id);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_TELEGRAM_UPDATE_ID_INVALID",
      "Telegram передал некорректный идентификатор обновления. Проверьте журнал интеграции",
    );
  }
  return String(parsed.data);
}

function queueKey(update: TelegramUpdate): string {
  if (update.kind === "callback_query" && !update.callbackQuery.message) {
    return `telegram:callback:${update.callbackQuery.id}`;
  }
  const message =
    update.kind === "message" ? update.message : update.callbackQuery.message!;

  // One FIFO per chat/topic is stricter than Eve's reply branches and avoids cross-anchor races.
  return telegramContinuationToken({
    chatId: message.chat.id,
    messageThreadId: message.messageThreadId,
  });
}

function voiceMetadata(raw: Record<string, unknown>) {
  const parsed = telegramVoiceSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const voice = parsed.data.message.voice;
  return {
    fileId: voice.file_id,
    ...(voice.file_size === undefined ? {} : { fileSize: voice.file_size }),
    ...(voice.mime_type === undefined ? {} : { mimeType: voice.mime_type }),
  };
}

function shouldTranscribeVoice(message: TelegramMessage, botUsername: string): boolean {
  const dispatchText = [message.text, message.caption].filter(Boolean).join("\n");
  return isMessageAddressedToBot({ ...message, text: dispatchText }, botUsername);
}

function withCaptionlessAttachmentText(update: TelegramUpdate): TelegramUpdate {
  if (
    update.kind !== "message" ||
    update.message.attachments.length === 0 ||
    update.message.text.trim() ||
    update.message.caption.trim()
  ) {
    return update;
  }

  // Eve no longer forwards persisted bytes to the text-only primary model. Keep its final user
  // message non-empty while describing only the verified event, not inventing a file request.
  return {
    ...update,
    message: {
      ...update.message,
      text: CAPTIONLESS_ATTACHMENT_MODEL_TEXT,
    },
  };
}

function withTranscript(payload: Record<string, unknown>, transcript: string): Record<string, unknown> {
  const cloned = structuredClone(payload);
  const message = cloned.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new AppError(
      "AGENT_TELEGRAM_VOICE_INVALID",
      "Telegram передал неполные данные голосового сообщения. Запишите и отправьте его заново",
    );
  }
  (message as Record<string, unknown>).text = transcript;
  return cloned;
}

export function createTelegramDurableIngress(dependencies: DurableIngressDependencies) {
  const messageSlots = new Sema(TELEGRAM_INGRESS_MESSAGE_CONCURRENCY);
  const callbackSlots = new Sema(TELEGRAM_INGRESS_CALLBACK_CONCURRENCY);
  async function maintainLease(
    updateId: string,
    leaseToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    const heartbeatMilliseconds = Math.floor(
      dependencies.leaseMilliseconds / LEASE_HEARTBEAT_DIVISOR,
    );
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timeout = setTimeout(done, heartbeatMilliseconds);
        signal.addEventListener("abort", done, { once: true });
      });
      if (signal.aborted) return;
      await dependencies.repository.renewLease(
        updateId,
        leaseToken,
        dependencies.leaseMilliseconds,
      );
    }
  }

  async function drain(
    dispatch: TelegramVerifiedUpdateContext["dispatch"],
    notifyTimeout: TelegramVerifiedUpdateContext["notifyTimeout"],
    attachSession: TelegramDrainContext["attachSession"],
  ): Promise<void> {
    while (true) {
      const claim = await dependencies.repository.claimNext(dependencies.leaseMilliseconds);
      if (!claim) return;
      const heartbeatController = new AbortController();
      let heartbeatError: unknown;
      const heartbeat = maintainLease(
          claim.updateId,
          claim.leaseToken,
          heartbeatController.signal,
        )
        .catch((error: unknown) => {
          heartbeatError = error;
          heartbeatController.abort(error);
        });
      let dispatchedSessionId: string | undefined;
      let releaseSlot: (() => void) | undefined;

      try {
        let payload = claim.payload;
        const acceptedUpdate = parseTelegramUpdate(payload);
        if (!acceptedUpdate) {
          await dependencies.repository.complete(claim.updateId, claim.leaseToken);
          continue;
        }

        // SQL coalesces each queue behind its live leased head. A waiter whose lease was lost
        // cannot dispatch after acquiring a slot; callbacks have capacity separate from model turns.
        const slots = acceptedUpdate.kind === "callback_query" ? callbackSlots : messageSlots;
        const waitedForSlot = slots.tryAcquire() === undefined;
        if (waitedForSlot) await slots.acquire();
        releaseSlot = () => slots.release();
        if (heartbeatError) throw heartbeatError;
        if (waitedForSlot) await dependencies.repository.renewLease(claim.updateId, claim.leaseToken, dependencies.leaseMilliseconds);

        if (claim.dispatchStarted) {
          const recovered = await recoverTelegramIngress({
            dispatch: claim.dispatchBinding,
            cancel: claim.recoveryCancelRequested,
            attach: attachSession,
            timeoutMs: dependencies.observerIdleMilliseconds ?? TELEGRAM_INGRESS_OBSERVER_IDLE_MS,
            cancellationMs: dependencies.cancellationMilliseconds ?? TELEGRAM_INGRESS_CANCELLATION_GRACE_MS,
            signal: heartbeatController.signal,
          });
          await dependencies.repository.completeWithSession(claim.updateId, claim.leaseToken,
            recovered.sessionId, recovered.nextEventIndex);
          console.info(JSON.stringify({ code: "AGENT_TELEGRAM_INGRESS_RECOVERED", updateId: claim.updateId,
            eveSessionId: recovered.sessionId }));
          continue;
        }
        const completion = await runTelegramProcessing({
          updateId: claim.updateId,
          signal: heartbeatController.signal,
          timeoutMilliseconds: dependencies.admissionMilliseconds ?? TELEGRAM_INGRESS_ADMISSION_TIMEOUT_MS,
          cancellationMilliseconds: dependencies.cancellationMilliseconds ?? TELEGRAM_INGRESS_CANCELLATION_GRACE_MS,
          readCursor: (id) => dependencies.repository.sessionEventStreamCursor(id),
          execute: async (control) => {
            let update: TelegramUpdate = acceptedUpdate;
            // Software updates are application-owned. Native HITL buttons must reach Eve's existing
            // onHitlCallbackQuery guard, which checks the exact pending request and current approver.
            if (update.kind === "callback_query") {
              const claimed = await dependencies.handleSoftwareUpdateCallback(update.callbackQuery);
              control.signal.throwIfAborted();
              const nativeHitl = update.callbackQuery.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX) === true;
              if (claimed || !nativeHitl) {
                if (!claimed) {
                  console.error(JSON.stringify({
                    code: "AGENT_TELEGRAM_CALLBACK_UNCLAIMED",
                    updateId: claim.updateId,
                  }));
                }
                return null;
              }
            }

            if (claim.voice && update.kind === "message" && shouldTranscribeVoice(update.message, dependencies.botUsername)) {
              const authorized = await dependencies.authorizeVoice(update.message);
              control.signal.throwIfAborted();
              if (authorized) {
                if (!claim.transcript) {
                  await dependencies.repository.beginVoiceTranscription(claim.updateId, claim.leaseToken);
                  control.signal.throwIfAborted();
                }
                const transcript = claim.transcript ??
                  (await dependencies.transcribeVoice({ ...claim.voice, signal: control.signal })).trim();
                control.signal.throwIfAborted();
                if (!transcript) {
                  throw new AppError(
                    "AGENT_VOICE_TRANSCRIPT_EMPTY",
                    "В голосовом сообщении не удалось распознать речь. Запишите его ещё раз",
                  );
                }
                if (!claim.transcript) {
                  await dependencies.repository.saveVoiceTranscript(claim.updateId, claim.leaseToken, transcript);
                  control.signal.throwIfAborted();
                }
                payload = withTranscript(payload, transcript);
                const transcribedUpdate = parseTelegramUpdate(payload);
                if (!transcribedUpdate) {
                  throw new AppError(
                    "AGENT_TELEGRAM_PAYLOAD_INVALID",
                    "Не удалось подготовить голосовое сообщение для обработки",
                  );
                }
                update = transcribedUpdate;
              }
            }

            control.signal.throwIfAborted();
            await dependencies.repository.beginDispatch(claim.updateId, claim.leaseToken, control.dispatchId);
            control.signal.throwIfAborted();
            const session = await dispatch(withCaptionlessAttachmentText(update), control);
            if (!session) return null;
            dispatchedSessionId = session.id;
            control.observeSession(session);
            control.signal.throwIfAborted();
            // The durable cursor excludes every event from earlier turns of a reused Eve session.
            const streamCursor = await dependencies.repository.sessionEventStreamCursor(session.id);
            control.signal.throwIfAborted();
            const nextEventIndex = await waitForSessionBoundary(
              session, streamCursor, dependencies.observerIdleMilliseconds ?? TELEGRAM_INGRESS_OBSERVER_IDLE_MS,
              { accepts: control.acceptsEvent, idle: true },
            );
            if (heartbeatError) throw heartbeatError;
            return { sessionId: session.id, nextEventIndex };
          },
        });
        if (completion === null) await dependencies.repository.complete(claim.updateId, claim.leaseToken);
        else await dependencies.repository.completeWithSession(
          claim.updateId,
          claim.leaseToken,
          completion.sessionId,
          completion.nextEventIndex,
        );
      } catch (error) {
        // A reclaimed dispatch marker is ambiguous: another durable execution may still be alive.
        // Do not admit the next message merely because automatic redelivery was refused.
        if (isAppError(error) && error.code === "AGENT_TELEGRAM_DISPATCH_RECOVERY_REQUIRED") {
          error = new TelegramProcessingTimeout(undefined, true, error);
        }
        if (error instanceof TelegramProcessingTimeout && error.eveSessionId) dispatchedSessionId = error.eveSessionId;
        const failure = {
          code: isAppError(error) ? error.code : "AGENT_TELEGRAM_INGRESS_FAILED",
          message: isAppError(error)
            ? error.message
            : "AGENT_TELEGRAM_INGRESS_FAILED: Не удалось обработать сообщение Telegram",
        };
        console.error(
          JSON.stringify({
            code: failure.code,
            error: error instanceof Error ? error.message : String(error),
            cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
            updateId: claim.updateId,
          }),
        );
        // The record is terminal, but the rest of the queue is not: a rethrow here left every
        // later message waiting for the next inbound webhook to start a new drain.
        // A lost observer has no trustworthy cursor. Do not reuse that canonical session and
        // accidentally consume its late waiting event as the next message's completion.
        await dependencies.repository.fail(claim.updateId, claim.leaseToken, failure, dispatchedSessionId);
        if (error instanceof TelegramProcessingTimeout) {
          const update = parseTelegramUpdate(claim.payload);
          if (update) {
            let noticeTimer: ReturnType<typeof setTimeout> | undefined;
            const noticeController = new AbortController();
            try {
              await Promise.race([notifyTimeout(update, failure.message, noticeController.signal), new Promise<never>((_resolve, reject) => {
                noticeTimer = setTimeout(() => reject(new Error("Telegram timeout notice did not settle")), TELEGRAM_INGRESS_CANCELLATION_GRACE_MS);
              })]);
            } catch (noticeError) {
              console.error(JSON.stringify({ code: "AGENT_TELEGRAM_TIMEOUT_NOTICE_FAILED", updateId: claim.updateId,
                errorName: noticeError instanceof Error ? noticeError.name : "UnknownError" }));
            } finally { clearTimeout(noticeTimer); noticeController.abort(); }
          }
        }
      } finally {
        releaseSlot?.();
        heartbeatController.abort();
        await heartbeat;
      }
    }
  }

  function scheduleDrain(context: TelegramDrainContext): void {
    // PostgreSQL leases only the first non-terminal item of each queue. Independent drainers
    // let another chat progress while a slow turn runs, without overtaking this chat's head.
    context.waitUntil(drain(context.dispatch, context.notifyTimeout, context.attachSession));
  }

  const handleVerifiedUpdate = async function handleVerifiedUpdate(
    context: TelegramVerifiedUpdateContext,
  ): Promise<Response> {
    const incomingUpdateId = updateId(context.raw);
    const mediaKind = context.update.kind === "message"
      ? classifyTelegramInboundMedia(context.update.message)
      : "none";
    // External media is acknowledged before durable storage, download, transcription, or Eve dispatch.
    if (
      context.update.kind === "message" &&
      mediaKind !== "none" &&
      !await dependencies.acceptMedia(context.update.message, incomingUpdateId, mediaKind)
    ) {
      return new Response("ok");
    }
    const voice = voiceMetadata(context.raw);
    await dependencies.repository.enqueue({
      continuationKey: queueKey(context.update),
      payload: context.raw,
      updateId: incomingUpdateId,
      ...(voice ? { voice } : {}),
    });
    scheduleDrain(context);
    return new Response("ok");
  };

  // The private poller uses the same native dispatcher without creating a synthetic update.
  handleVerifiedUpdate.drain = async (context: TelegramDrainContext): Promise<Response> => {
    scheduleDrain(context);
    return new Response("ok", { headers: { "x-osinara-runtime-admission": "1" } });
  };
  return handleVerifiedUpdate as TelegramDurableIngressHandler;
}

const authorizeTelegramVoice = createTelegramVoiceAuthorizer(telegramRepository);

export const handleTelegramDurableIngress = createTelegramDurableIngress({
  acceptMedia(message, incomingUpdateId, mediaKind) {
    return telegramIngressRepository.acceptMedia({
      chatId: message.chat.id,
      chatType: message.chat.type,
      mediaKind,
      updateId: incomingUpdateId,
    });
  },
  authorizeVoice: authorizeTelegramVoice,
  botUsername: process.env.TELEGRAM_BOT_USERNAME as string,
  handleSoftwareUpdateCallback,
  leaseMilliseconds: TELEGRAM_INGRESS_LEASE_MS,
  repository: telegramIngressRepository,
  transcribeVoice: transcribeTelegramVoice,
});
