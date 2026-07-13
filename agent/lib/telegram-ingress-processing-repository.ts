/**
 * PostgreSQL Telegram ingress processing markers.
 *
 * Exports:
 * - `telegramIngressProcessingRepository`: exactly-once barriers for provider and Eve dispatch.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  requireNonEmpty,
  requireUpdateId,
  requireUuid,
  type TelegramIngressRepository,
} from "./telegram-ingress-contract.js";

type ProcessingOperations = Pick<
  TelegramIngressRepository,
  "beginDispatch" | "beginVoiceTranscription" | "saveVoiceTranscript"
>;

export const telegramIngressProcessingRepository: ProcessingOperations = {
  async beginVoiceTranscription(updateId, leaseToken) {
    requireUuid(leaseToken, "AGENT_TELEGRAM_LEASE_INVALID", "Токен аренды обработки Telegram имеет некорректный формат");
    const started = await database().query(
      `UPDATE telegram_ingress_updates
       SET voice_transcription_started_at = now(), updated_at = now()
       WHERE update_id = $1 AND status = 'processing' AND lease_token = $2
         AND lease_expires_at > now() AND voice_file_id IS NOT NULL
         AND voice_transcription_started_at IS NULL
       RETURNING update_id`,
      [requireUpdateId(updateId), leaseToken],
    );
    if (started.rowCount === 1) return "started";

    // A completed transcript is reusable; an interrupted provider call is never billed twice.
    const existing = await database().query<{
      active: boolean;
      voice_transcript: string | null;
      voice_transcription_started_at: Date | null;
    }>(
      `SELECT status = 'processing' AND lease_token = $2 AND lease_expires_at > now() AS active,
              voice_transcript, voice_transcription_started_at
       FROM telegram_ingress_updates WHERE update_id = $1`,
      [updateId, leaseToken],
    );
    const row = existing.rows[0];
    if (!row?.active) {
      throw new AppError("AGENT_TELEGRAM_LEASE_LOST", "Срок обработки голосового сообщения истёк. Операция остановлена");
    }
    if (row.voice_transcript) return "completed";
    if (row.voice_transcription_started_at) {
      throw new AppError(
        "AGENT_VOICE_TRANSCRIPTION_RECOVERY_REQUIRED",
        "Распознавание голосового сообщения было прервано. Отправьте запись повторно",
      );
    }
    throw new AppError("AGENT_TELEGRAM_VOICE_INVALID", "Для сообщения не найдены данные голосовой записи");
  },

  async beginDispatch(updateId, leaseToken) {
    requireUuid(leaseToken, "AGENT_TELEGRAM_LEASE_INVALID", "Токен аренды обработки Telegram имеет некорректный формат");
    const started = await database().query(
      `UPDATE telegram_ingress_updates
       SET dispatch_started_at = now(), updated_at = now()
       WHERE update_id = $1 AND status = 'processing' AND lease_token = $2
         AND lease_expires_at > now() AND dispatch_started_at IS NULL
       RETURNING update_id`,
      [requireUpdateId(updateId), leaseToken],
    );
    if (started.rowCount === 1) return;

    const existing = await database().query<{ active: boolean }>(
      `SELECT status = 'processing' AND lease_token = $2 AND lease_expires_at > now() AS active
       FROM telegram_ingress_updates WHERE update_id = $1`,
      [updateId, leaseToken],
    );
    if (!existing.rows[0]?.active) {
      throw new AppError("AGENT_TELEGRAM_LEASE_LOST", "Срок передачи сообщения в Eve истёк. Операция остановлена");
    }
    throw new AppError(
      "AGENT_TELEGRAM_DISPATCH_RECOVERY_REQUIRED",
      "Передача сообщения в Eve была прервана. Автоматический повтор отключён для защиты от двойного действия",
    );
  },

  async saveVoiceTranscript(updateId, leaseToken, transcript) {
    const normalizedTranscript = transcript.trim();
    requireNonEmpty(normalizedTranscript, "AGENT_VOICE_TRANSCRIPT_EMPTY", "В голосовом сообщении не удалось распознать речь. Запишите его ещё раз");
    requireUuid(leaseToken, "AGENT_TELEGRAM_LEASE_INVALID", "Токен аренды обработки Telegram имеет некорректный формат");
    const result = await database().query<{ voice_transcript: string }>(
      `UPDATE telegram_ingress_updates
       SET voice_transcript = COALESCE(voice_transcript, $3),
           voice_transcribed_at = COALESCE(voice_transcribed_at, now()), updated_at = now()
       WHERE update_id = $1 AND status = 'processing' AND lease_token = $2
         AND lease_expires_at > now() AND voice_file_id IS NOT NULL
         AND voice_transcription_started_at IS NOT NULL
       RETURNING voice_transcript`,
      [requireUpdateId(updateId), leaseToken, normalizedTranscript],
    );
    const persisted = result.rows[0]?.voice_transcript;
    if (!persisted) {
      throw new AppError("AGENT_TELEGRAM_LEASE_LOST", "Срок обработки голосового сообщения истёк. Результат не был сохранён");
    }
    if (persisted !== normalizedTranscript) {
      throw new AppError("AGENT_VOICE_TRANSCRIPT_CONFLICT", "Для голосового сообщения уже сохранён другой результат распознавания. Обработка остановлена");
    }
  },
};
