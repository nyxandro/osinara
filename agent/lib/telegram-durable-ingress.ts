/**
 * Durable Telegram ingress coordinator.
 *
 * Exports:
 * - `createTelegramDurableIngress`: the verified webhook hook that stores an update before Telegram
 *   is acknowledged, and the drain that processes stored updates in each chat's order.
 * - `TelegramDurableIngressHandler`: the webhook handler with its `drain`.
 * - Application software-update callbacks complete before any turn is dispatched.
 * - A chat queue with no waiting update may run one due wake-up of its own conversation.
 *
 * One update runs to the end of its turn before the next update of its chat starts. The update
 * and its turn are bound in the transaction that creates the turn; after a restart a bound update
 * lets its turn finish from the journal and is never dispatched again.
 */
import { randomUUID } from "node:crypto";

import type { TelegramMessage, TelegramUpdate } from "../runtime/telegram/inbound.js";
import { isTelegramHitlCallback } from "../runtime/telegram/hitl.js";
import { parseTelegramUpdate } from "../runtime/telegram/inbound.js";
import { telegramContinuationToken } from "../runtime/telegram/api.js";
import type { JsonObject } from "../runtime/json.js";
import type { RouteContext } from "../runtime/server.js";
import type { TelegramDispatchControl, TelegramDispatchResult } from "../runtime/telegram/telegram-dispatch.js";
import type { TurnOutcome } from "../runtime/turn/run-turn.js";
import { z } from "zod";
import { Sema } from "async-sema";

import {
  TELEGRAM_INGRESS_CALLBACK_CONCURRENCY,
  TELEGRAM_INGRESS_WAKEUP_CONCURRENCY,
  TELEGRAM_PRIVATE_BURST_MAX_CHARACTERS,
  TELEGRAM_PRIVATE_BURST_MAX_MESSAGES,
  TELEGRAM_PRIVATE_BURST_MAX_WAIT_MS,
  TELEGRAM_PRIVATE_BURST_QUIET_MS,
  TELEGRAM_INGRESS_ADMISSION_TIMEOUT_MS,
  TELEGRAM_INGRESS_MESSAGE_CONCURRENCY,
} from "../config.js";
import { AppError, isAppError } from "./app-error.js";
import { type TelegramIngressRepository, type TelegramPrivateBurstPolicy } from "./telegram-ingress-contract.js";
import { waitForHeldPrivateChat } from "./telegram-private-burst.js";
import {
  classifyTelegramInboundMedia,
  isMessageAddressedToBot,
  type TelegramInboundMediaKind,
} from "./telegram-message-policy.js";
import { telegramIngressControl } from "./telegram-ingress-dispatch.js";
import { combineTelegramMediaGroup } from "./telegram-media-group.js";
import { combineTelegramBurst } from "./telegram-private-burst-message.js";
import { recordOperationalIncident } from "./operational-incidents/owner-alerts.js";
import { isDatabaseUnavailable, waitForApplicationDatabase } from "./database-recovery.js";

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

export interface DurableIngressDependencies {
  reportFailure: typeof recordOperationalIncident;
  acceptMedia(
    message: Pick<TelegramMessage, "chat">,
    updateId: string,
    mediaKind: Exclude<TelegramInboundMediaKind, "none">,
  ): Promise<boolean>;
  authorizeVoice(message: Pick<TelegramMessage, "chat" | "from">): Promise<boolean>;
  botUsername: string;
  /** The runtime's Telegram dispatch: the update's turn, created with the update's binding. */
  dispatch(update: TelegramUpdate, control: TelegramDispatchControl): Promise<TelegramDispatchResult>;
  handleSoftwareUpdateCallback(
    query: Extract<TelegramUpdate, { kind: "callback_query" }>["callbackQuery"],
  ): Promise<boolean>;
  leaseMilliseconds: number;
  /** Runs at most one due wake-up of an idle chat queue on the wake-up slots, never a message slot. */
  processConversationWakeup?(input: { slots: Sema }): Promise<boolean>;
  admissionMilliseconds?: number;
  privateBurst?: TelegramPrivateBurstPolicy;
  repository: TelegramIngressRepository;
  /** Runs a turn to its end, or returns the outcome of one that already ended. */
  runTurn(turnId: string): Promise<TurnOutcome>;
  transcribeVoice(input: {
    fileId: string;
    fileSize?: number;
    mimeType?: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface TelegramDurableIngressHandler {
  (context: RouteContext & { readonly raw: JsonObject; readonly update: TelegramUpdate }): Promise<Response>;
  drain(context: RouteContext): Promise<Response>;
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

  // The runtime does not forward persisted bytes to the text-only primary model. Keep its final user
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
  const wakeupSlots = new Sema(TELEGRAM_INGRESS_WAKEUP_CONCURRENCY);
  const privateBurst = dependencies.privateBurst ?? {
    maxCharacters: TELEGRAM_PRIVATE_BURST_MAX_CHARACTERS,
    maxMessages: TELEGRAM_PRIVATE_BURST_MAX_MESSAGES,
    maxWaitMilliseconds: TELEGRAM_PRIVATE_BURST_MAX_WAIT_MS,
    quietMilliseconds: TELEGRAM_PRIVATE_BURST_QUIET_MS,
  };
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

  /** Voice is transcribed once per update; the transcript is stored before any dispatch. */
  async function withVoiceTranscript(
    claim: NonNullable<Awaited<ReturnType<TelegramIngressRepository["claimNext"]>>>,
    update: TelegramUpdate,
    signal: AbortSignal,
  ): Promise<TelegramUpdate> {
    if (!claim.voice || update.kind !== "message" || !shouldTranscribeVoice(update.message, dependencies.botUsername)) return update;
    const authorized = await dependencies.authorizeVoice(update.message);
    signal.throwIfAborted();
    if (!authorized) return update;
    if (!claim.transcript) {
      await dependencies.repository.beginVoiceTranscription(claim.updateId, claim.leaseToken);
      signal.throwIfAborted();
    }
    const transcript = claim.transcript ??
      (await dependencies.transcribeVoice({ ...claim.voice, signal })).trim();
    signal.throwIfAborted();
    if (!transcript) {
      throw new AppError(
        "AGENT_VOICE_TRANSCRIPT_EMPTY",
        "В голосовом сообщении не удалось распознать речь. Запишите его ещё раз",
      );
    }
    if (!claim.transcript) {
      await dependencies.repository.saveVoiceTranscript(claim.updateId, claim.leaseToken, transcript);
      signal.throwIfAborted();
    }
    const transcribedUpdate = parseTelegramUpdate(withTranscript(claim.payload, transcript));
    if (!transcribedUpdate) {
      throw new AppError(
        "AGENT_TELEGRAM_PAYLOAD_INVALID",
        "Не удалось подготовить голосовое сообщение для обработки",
      );
    }
    return transcribedUpdate;
  }

  /** Dispatches the update and runs its turn; returns the session it ran in, or null for none. */
  async function process(
    claim: NonNullable<Awaited<ReturnType<TelegramIngressRepository["claimNext"]>>>,
    acceptedUpdate: TelegramUpdate,
    signal: AbortSignal,
  ): Promise<string | null> {
    const binding = claim.dispatchBinding;
    if (claim.dispatchStarted && binding !== null) {
      // The update already created its turn; after a restart that turn only finishes.
      await dependencies.runTurn(binding.turnId);
      console.info(JSON.stringify({ code: "AGENT_TELEGRAM_INGRESS_RECOVERED", sessionId: binding.sessionId, updateId: claim.updateId }));
      return binding.sessionId;
    }
    if (claim.dispatchStarted && claim.recoveryProtocol !== 1) {
      throw new AppError(
        "AGENT_TELEGRAM_DISPATCH_RECOVERY_REQUIRED",
        "Передача сообщения была прервана. Автоматический повтор отключён для защиты от двойного действия",
      );
    }
    // A preparation that outlives its admission window creates no turn.
    const admission = new AbortController();
    const deadlineAt = new Date(Date.now() + (dependencies.admissionMilliseconds ?? TELEGRAM_INGRESS_ADMISSION_TIMEOUT_MS));
    const timer = setTimeout(() => admission.abort(new AppError(
      "AGENT_TELEGRAM_PROCESSING_TIMEOUT",
      "Запрос превысил время обработки и остановлен. Если он менял данные, проверьте результат перед повтором",
    )), deadlineAt.getTime() - Date.now());
    const stop = AbortSignal.any([admission.signal, signal]);
    try {
      let update = acceptedUpdate;
      // Software updates are application-owned. Runtime buttons reach the application's guard,
      // which checks the exact pending request and current approver.
      if (update.kind === "callback_query") {
        const claimed = await dependencies.handleSoftwareUpdateCallback(update.callbackQuery);
        stop.throwIfAborted();
        const runtimeButton = isTelegramHitlCallback(update.callbackQuery.data);
        if (claimed || !runtimeButton) {
          if (!claimed) console.error(JSON.stringify({ code: "AGENT_TELEGRAM_CALLBACK_UNCLAIMED", updateId: claim.updateId }));
          return null;
        }
      }
      update = await withVoiceTranscript(claim, update, stop);
      // A dispatch interrupted before its turn existed is prepared again under its own attempt id:
      // the preparation's stored result and its fenced Telegram effects are reused, never repeated.
      const dispatchId = claim.dispatchAttemptId ?? randomUUID();
      if (!claim.dispatchStarted) {
        await dependencies.repository.beginDispatch(claim.updateId, claim.leaseToken, dispatchId);
        stop.throwIfAborted();
      }
      const result = await dependencies.dispatch(withCaptionlessAttachmentText(update), telegramIngressControl({
        deadlineAt: deadlineAt.toISOString(), dispatchId, leaseToken: claim.leaseToken, replaying: claim.dispatchStarted, signal: stop,
        updateId: claim.updateId,
      }));
      clearTimeout(timer);
      if (result.status === "dropped") return null;
      await dependencies.runTurn(result.turnId);
      return result.sessionId;
    } finally {
      clearTimeout(timer);
    }
  }

  async function drain(): Promise<void> {
    while (true) {
      const claim = await dependencies.repository.claimNext(dependencies.leaseMilliseconds, privateBurst);
      if (!claim) {
        // Messages go first; a wake-up takes a chat queue only when that queue holds none.
        if (await dependencies.processConversationWakeup?.({ slots: wakeupSlots })) continue;
        if (await waitForHeldPrivateChat(dependencies.repository, privateBurst)) continue;
        return;
      }
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
      let dispatchedSessionId: string | undefined = claim.dispatchBinding?.sessionId;
      let releaseSlot: (() => void) | undefined;

      try {
        if (claim.mediaGroupLate) {
          throw new AppError("AGENT_TELEGRAM_MEDIA_GROUP_LATE",
            "Один из файлов пришёл после начала обработки пачки и не был обработан. Отправьте его отдельно с нужной просьбой");
        }
        const acceptedUpdate = claim.mediaGroupPayloads
          ? combineTelegramMediaGroup(claim.mediaGroupPayloads)
          : claim.burstPayloads ? combineTelegramBurst(claim.burstPayloads) : parseTelegramUpdate(claim.payload);
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

        const sessionId = await process(claim, acceptedUpdate, heartbeatController.signal);
        if (sessionId !== null) dispatchedSessionId = sessionId;
        if (heartbeatError) throw heartbeatError;
        await dependencies.repository.complete(claim.updateId, claim.leaseToken, sessionId ?? undefined);
      } catch (error) {
        if (isAppError(error) && error.code === "AGENT_TELEGRAM_LEASE_LOST") {
          console.info(JSON.stringify({ code: "AGENT_TELEGRAM_OBSERVER_TRANSFERRED", updateId: claim.updateId }));
          continue;
        }
        if (isDatabaseUnavailable(error)) {
          await waitForApplicationDatabase();
          await dependencies.repository.release(claim.updateId, claim.leaseToken, {
            code: "AGENT_TELEGRAM_DATABASE_RECOVERY", message: "Соединение восстановлено. Продолжается проверка исходного запроса",
          });
          continue;
        }
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
        await dependencies.repository.fail(claim.updateId, claim.leaseToken, failure, dispatchedSessionId);
        const failedUpdate = parseTelegramUpdate(claim.payload);
        const origin = failedUpdate?.kind === "message" ? failedUpdate.message : failedUpdate?.callbackQuery.message;
        await dependencies.reportFailure({ key: `telegram:${claim.updateId}`, code: failure.code,
          summary: failure.message, context: { updateId: claim.updateId, queueId: claim.queueId,
            chatId: origin?.chat.id ?? null, eveSessionId: dispatchedSessionId ?? null } });
      } finally {
        releaseSlot?.();
        heartbeatController.abort();
        await heartbeat;
      }
    }
  }

  function scheduleDrain(context: RouteContext): void {
    // PostgreSQL leases only the first non-terminal item of each queue. Independent drainers
    // let another chat progress while a slow turn runs, without overtaking this chat's head.
    context.waitUntil(drain());
  }

  const handleVerifiedUpdate = async function handleVerifiedUpdate(
    context: RouteContext & { readonly raw: JsonObject; readonly update: TelegramUpdate },
  ): Promise<Response> {
    const incomingUpdateId = updateId(context.raw);
    const mediaKind = context.update.kind === "message"
      ? classifyTelegramInboundMedia(context.update.message)
      : "none";
    // External media is acknowledged before durable storage, download, transcription, or dispatch.
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

  // The private poller drains the same queue without creating a synthetic update.
  handleVerifiedUpdate.drain = async (context: RouteContext): Promise<Response> => {
    scheduleDrain(context);
    return new Response("ok", { headers: { "x-osinara-runtime-admission": "1" } });
  };
  return handleVerifiedUpdate as TelegramDurableIngressHandler;
}
