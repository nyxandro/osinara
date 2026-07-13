/**
 * Durable Telegram ingress contracts and boundary validation.
 *
 * Exports:
 * - `TelegramIngressRepository`: persistence operations required by a future Eve ingress bridge.
 * - `TelegramIngressClaim`: one lease-protected FIFO item.
 * - `ClaimRow` and `mapTelegramIngressClaim`: PostgreSQL row normalization.
 * - Validation helpers: fail-fast checks for update ids, leases, failures, and enqueue payloads.
 */
import { AppError } from "./app-error.js";

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TelegramIngressVoice {
  fileId: string;
  fileSize?: number;
  mimeType?: string;
}

export interface EnqueueTelegramUpdateInput {
  continuationKey: string;
  payload: Record<string, unknown>;
  updateId: string;
  voice?: TelegramIngressVoice;
}

export interface TelegramIngressFailure {
  code: string;
  message: string;
}

export interface TelegramIngressClaim {
  attemptCount: number;
  deliveryContinuationKey: string;
  ingressContinuationKey: string;
  leaseExpiresAt: Date;
  leaseToken: string;
  payload: Record<string, unknown>;
  queueId: string;
  transcript: string | null;
  updateId: string;
  voice: TelegramIngressVoice | null;
}

export interface TelegramIngressRepository {
  beginVoiceTranscription(updateId: string, leaseToken: string): Promise<"completed" | "started">;
  beginDispatch(updateId: string, leaseToken: string): Promise<void>;
  claimNext(leaseMilliseconds: number): Promise<TelegramIngressClaim | null>;
  complete(updateId: string, leaseToken: string): Promise<void>;
  completeWithSession(updateId: string, leaseToken: string, sessionId: string): Promise<void>;
  enqueue(input: EnqueueTelegramUpdateInput): Promise<"duplicate" | "inserted">;
  fail(updateId: string, leaseToken: string, failure: TelegramIngressFailure): Promise<void>;
  rekeyQueue(input: {
    nextContinuationKey: string;
    previousContinuationKey: string;
    queueId: string;
  }): Promise<void>;
  release(updateId: string, leaseToken: string, failure: TelegramIngressFailure): Promise<void>;
  renewLease(updateId: string, leaseToken: string, leaseMilliseconds: number): Promise<Date>;
  saveVoiceTranscript(updateId: string, leaseToken: string, transcript: string): Promise<void>;
}

export interface ClaimRow {
  attempt_count: number;
  current_continuation_key: string;
  ingress_continuation_key: string;
  lease_expires_at: Date;
  lease_token: string;
  payload: Record<string, unknown>;
  queue_id: string;
  update_id: string;
  voice_file_id: string | null;
  voice_file_size: string | null;
  voice_mime_type: string | null;
  voice_transcript: string | null;
}

export function requireNonEmpty(value: string, code: string, message: string): string {
  if (!value.trim()) throw new AppError(code, message);
  return value;
}

export function requireUpdateId(updateId: string): string {
  if (!/^(0|[1-9]\d*)$/.test(updateId) || BigInt(updateId) > POSTGRES_BIGINT_MAX) {
    throw new AppError(
      "AGENT_TELEGRAM_UPDATE_ID_INVALID",
      "Telegram передал некорректный идентификатор обновления. Проверьте журнал интеграции",
    );
  }
  return updateId;
}

export function requireLeaseMilliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppError(
      "AGENT_TELEGRAM_LEASE_INVALID",
      "Срок аренды обработки Telegram должен быть положительным целым числом",
    );
  }
  return value;
}

export function requireUuid(value: string, code: string, message: string): string {
  if (!UUID_PATTERN.test(value)) throw new AppError(code, message);
  return value;
}

export function requireFailure(failure: TelegramIngressFailure): TelegramIngressFailure {
  requireNonEmpty(
    failure.code,
    "AGENT_TELEGRAM_FAILURE_CODE_INVALID",
    "Для ошибки обработки Telegram не задан стабильный код",
  );
  requireNonEmpty(
    failure.message,
    "AGENT_TELEGRAM_FAILURE_MESSAGE_INVALID",
    "Для ошибки обработки Telegram не задано понятное описание",
  );
  return failure;
}

export function validateEnqueueInput(input: EnqueueTelegramUpdateInput): void {
  requireUpdateId(input.updateId);
  requireNonEmpty(
    input.continuationKey,
    "AGENT_TELEGRAM_CONTINUATION_INVALID",
    "Не удалось определить очередь Telegram для входящего сообщения",
  );
  if (!input.payload || Array.isArray(input.payload)) {
    throw new AppError(
      "AGENT_TELEGRAM_PAYLOAD_INVALID",
      "Telegram передал некорректное обновление. Проверьте настройку webhook",
    );
  }
  if (!input.voice) return;

  // Voice metadata is persisted before any provider call and must be complete enough to replay.
  requireNonEmpty(
    input.voice.fileId,
    "AGENT_TELEGRAM_VOICE_INVALID",
    "Telegram передал неполные данные голосового сообщения. Запишите и отправьте его заново",
  );
  if (
    input.voice.fileSize !== undefined &&
    (!Number.isSafeInteger(input.voice.fileSize) || input.voice.fileSize <= 0)
  ) {
    throw new AppError(
      "AGENT_TELEGRAM_VOICE_INVALID",
      "Telegram передал некорректный размер голосового сообщения. Запишите и отправьте его заново",
    );
  }
}

export function mapTelegramIngressClaim(row: ClaimRow): TelegramIngressClaim {
  // Optional voice fields become a single typed value so callers cannot observe partial metadata.
  const voice = row.voice_file_id
    ? {
        fileId: row.voice_file_id,
        ...(row.voice_file_size === null ? {} : { fileSize: Number(row.voice_file_size) }),
        ...(row.voice_mime_type === null ? {} : { mimeType: row.voice_mime_type }),
      }
    : null;
  return {
    attemptCount: row.attempt_count,
    deliveryContinuationKey: row.current_continuation_key,
    ingressContinuationKey: row.ingress_continuation_key,
    leaseExpiresAt: row.lease_expires_at,
    leaseToken: row.lease_token,
    payload: row.payload,
    queueId: row.queue_id,
    transcript: row.voice_transcript,
    updateId: row.update_id,
    voice,
  };
}
