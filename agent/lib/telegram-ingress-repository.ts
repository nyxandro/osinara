/**
 * PostgreSQL durable Telegram ingress repository.
 *
 * Exports:
 * - `telegramIngressRepository`: production PostgreSQL implementation.
 */
import type { PoolClient } from "pg";

import { TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED } from "../config.js";
import { AppError } from "./app-error.js";
import { parseExternalGroupToolAllowlist } from "./tool-policy/group-tool-catalog.js";
import { database } from "./database.js";
import {
  requireFailure,
  requireLeaseMilliseconds,
  requireNonEmpty,
  requireUpdateId,
  requireUuid,
  type TelegramIngressRepository,
  validateEnqueueInput,
} from "./telegram-ingress-contract.js";
import { telegramIngressProcessingRepository } from "./telegram-ingress-processing-repository.js";
import { telegramIngressSessionCursorRepository } from "./telegram-ingress-session-cursor-repository.js";
import { claimNextTelegramIngress } from "./telegram-ingress-claim-repository.js";
import { registerTelegramMediaGroupMember, settleTelegramMediaGroupMembersSql } from "./telegram-media-group-repository.js";

const IGNORED_MEDIA_REASON = "external_media";

async function insertIgnoredMedia(client: PoolClient, updateId: string): Promise<void> {
  await client.query(
    `INSERT INTO telegram_ingress_ignored_updates (update_id, reason)
     VALUES ($1, $2)
     ON CONFLICT (update_id) DO NOTHING`,
    [updateId, IGNORED_MEDIA_REASON],
  );
}

async function rollbackAndRethrow(client: PoolClient, error: unknown): Promise<never> {
  await client.query("ROLLBACK");
  throw error;
}

async function requireActiveLease(
  updateId: string,
  leaseToken: string,
  operation: () => Promise<number>,
): Promise<void> {
  requireUpdateId(updateId);
  requireNonEmpty(
    leaseToken,
    "AGENT_TELEGRAM_LEASE_INVALID",
    "Не задан токен аренды обработки Telegram",
  );
  requireUuid(
    leaseToken,
    "AGENT_TELEGRAM_LEASE_INVALID",
    "Токен аренды обработки Telegram имеет некорректный формат",
  );
  if ((await operation()) === 0) {
    throw new AppError(
      "AGENT_TELEGRAM_LEASE_LOST",
      "Срок обработки сообщения Telegram истёк. Операция остановлена для безопасного повторного запуска",
    );
  }
}

export const telegramIngressRepository: TelegramIngressRepository = {
  ...telegramIngressProcessingRepository,
  ...telegramIngressSessionCursorRepository,

  async acceptMedia(input) {
    requireUpdateId(input.updateId);
    requireNonEmpty(
      input.chatId,
      "AGENT_TELEGRAM_CHAT_ID_INVALID",
      "Telegram не передал идентификатор чата для проверки медиа",
    );
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [input.updateId]);
      const ignored = await client.query(
        "SELECT 1 FROM telegram_ingress_ignored_updates WHERE update_id = $1",
        [input.updateId],
      );
      if (ignored.rowCount) {
        await client.query("COMMIT");
        return false;
      }
      const queued = await client.query(
        "SELECT 1 FROM telegram_ingress_updates WHERE update_id = $1",
        [input.updateId],
      );
      if (queued.rowCount) {
        await client.query("COMMIT");
        return true;
      }
      if (input.chatType === "private") {
        await client.query("COMMIT");
        return true;
      }
      if (input.chatType === "channel") {
        await insertIgnoredMedia(client, input.updateId);
        await client.query("COMMIT");
        return false;
      }

      // Serialize absent rows and type changes with group administration before fixing the decision.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [input.chatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
      );
      const group = await client.query<{ tool_allowlist: string[]; type: string }>(
        `SELECT type::text, tool_allowlist
         FROM telegram_groups
         WHERE telegram_chat_id = $1
         FOR SHARE`,
        [input.chatId],
      );
      const policy = group.rows[0];
      const externalAllowlist = parseExternalGroupToolAllowlist(policy?.tool_allowlist);
      if (policy?.type === "family_private") {
        await client.query("COMMIT");
        return true;
      }
      if (
        policy?.type === "external" &&
        input.mediaKind === "text_document_candidate" &&
        externalAllowlist?.has("import_telegram_attachment") === true
      ) {
        await client.query("COMMIT");
        return true;
      }
      if (
        policy?.type === "external" &&
          (input.mediaKind === "native_photo" || input.mediaKind === "image_document_candidate") &&
        externalAllowlist?.has("inspect_workspace_image") === true
      ) {
        await client.query("COMMIT");
        return true;
      }
      await insertIgnoredMedia(client, input.updateId);
      await client.query("COMMIT");
      return false;
    } catch (error) {
      return rollbackAndRethrow(client, error);
    } finally {
      client.release();
    }
  },

  async enqueue(input) {
    validateEnqueueInput(input);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // One update-id lock serializes accepted payloads with payload-free ignored tombstones.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [input.updateId]);
      const ignored = await client.query(
        "SELECT 1 FROM telegram_ingress_ignored_updates WHERE update_id = $1",
        [input.updateId],
      );
      if (ignored.rowCount) {
        await client.query("COMMIT");
        return "duplicate";
      }

      // Serialize first use of one continuation without blocking unrelated Telegram conversations.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        input.continuationKey,
      ]);
      const alias = await client.query<{ queue_id: string }>(
        "SELECT queue_id FROM telegram_ingress_continuation_aliases WHERE continuation_key = $1",
        [input.continuationKey],
      );
      let queueId = alias.rows[0]?.queue_id;
      if (!queueId) {
        const queue = await client.query<{ id: string }>(
          "INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ($1) RETURNING id",
          [input.continuationKey],
        );
        queueId = queue.rows[0]!.id;
        await client.query(
          "INSERT INTO telegram_ingress_continuation_aliases (continuation_key, queue_id) VALUES ($1, $2)",
          [input.continuationKey, queueId],
        );
      }

      // Claims lock this same queue: a member either joins before sealing or is explicitly late.
      await client.query("SELECT id FROM telegram_ingress_queues WHERE id = $1 FOR UPDATE", [queueId]);
      // Telegram retries are accepted only when every persisted input byte and routing field agrees.
      const inserted = await client.query(
        `INSERT INTO telegram_ingress_updates
           (update_id, queue_id, ingress_continuation_key, payload,
            voice_file_id, voice_file_size, voice_mime_type)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
         ON CONFLICT (update_id) DO NOTHING
         RETURNING update_id`,
        [
          input.updateId,
          queueId,
          input.continuationKey,
          JSON.stringify(input.payload),
          input.voice?.fileId ?? null,
          input.voice?.fileSize ?? null,
          input.voice?.mimeType ?? null,
        ],
      );
      if (inserted.rowCount === 1) {
        await registerTelegramMediaGroupMember(client, input, queueId);
        await client.query("COMMIT");
        return "inserted";
      }
      const existing = await client.query<{ identical: boolean }>(
        `SELECT queue_id = $2
             AND ingress_continuation_key = $3
             AND payload = $4::jsonb
             AND voice_file_id IS NOT DISTINCT FROM $5
             AND voice_file_size IS NOT DISTINCT FROM $6::bigint
             AND voice_mime_type IS NOT DISTINCT FROM $7 AS identical
         FROM telegram_ingress_updates
         WHERE update_id = $1`,
        [
          input.updateId,
          queueId,
          input.continuationKey,
          JSON.stringify(input.payload),
          input.voice?.fileId ?? null,
          input.voice?.fileSize ?? null,
          input.voice?.mimeType ?? null,
        ],
      );
      if (existing.rows[0]?.identical !== true) {
        throw new AppError(
          "AGENT_TELEGRAM_UPDATE_CONFLICT",
          "Telegram повторно прислал идентификатор обновления с другими данными. Обработка остановлена",
        );
      }
      await client.query("COMMIT");
      return "duplicate";
    } catch (error) {
      return rollbackAndRethrow(client, error);
    } finally {
      client.release();
    }
  },

  claimNext: claimNextTelegramIngress,

  async renewLease(updateId, leaseToken, leaseMilliseconds) {
    requireLeaseMilliseconds(leaseMilliseconds);
    let expiresAt: Date | undefined;
    await requireActiveLease(updateId, leaseToken, async () => {
      const result = await database().query<{ lease_expires_at: Date }>(
        `UPDATE telegram_ingress_updates
         SET lease_expires_at = now() + ($3 * interval '1 millisecond'), updated_at = now()
         WHERE update_id = $1 AND status = 'processing' AND lease_token = $2
           AND lease_expires_at > now()
         RETURNING lease_expires_at`,
        [updateId, leaseToken, leaseMilliseconds],
      );
      expiresAt = result.rows[0]?.lease_expires_at;
      return result.rowCount ?? 0;
    });
    return expiresAt!;
  },

  async complete(updateId, leaseToken) {
    await requireActiveLease(updateId, leaseToken, async () => {
      const result = await database().query(
        `WITH finished AS (
           UPDATE telegram_ingress_updates
           SET status = 'completed', completed_at = now(),
               lease_token = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE update_id = $1 AND status = 'processing' AND lease_token = $2
             AND lease_expires_at > now()
           RETURNING *
         ), ${settleTelegramMediaGroupMembersSql} SELECT update_id FROM finished`,
        [updateId, leaseToken],
      );
      return result.rowCount ?? 0;
    });
  },

  async release(updateId, leaseToken, failure) {
    requireFailure(failure);
    await requireActiveLease(updateId, leaseToken, async () => {
      const result = await database().query(
        `UPDATE telegram_ingress_updates
         SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
             last_error_code = $3, last_error_message = $4, updated_at = now()
         WHERE update_id = $1 AND status = 'processing' AND lease_token = $2
           AND lease_expires_at > now()`,
        [updateId, leaseToken, failure.code, failure.message],
      );
      return result.rowCount ?? 0;
    });
  },

  async fail(updateId, leaseToken, failure, eveSessionId) {
    requireFailure(failure);
    if (eveSessionId !== undefined) {
      requireNonEmpty(eveSessionId, "AGENT_TELEGRAM_SESSION_INVALID", "Eve не вернул идентификатор сессии");
    }
    await requireActiveLease(updateId, leaseToken, async () => {
      const result = await database().query(
        `WITH finished AS (
           UPDATE telegram_ingress_updates
           SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
               last_error_code = $3, last_error_message = $4, eve_session_id = $5,
               completed_at = now(), updated_at = now()
           WHERE update_id = $1 AND status = 'processing' AND lease_token = $2
             AND lease_expires_at > now()
           RETURNING *
         ), ${settleTelegramMediaGroupMembersSql}, rotated AS (
           UPDATE conversation_sessions AS session SET rotation_requested_at = now()
           FROM finished WHERE session.eve_session_id = finished.eve_session_id
             AND session.kind = 'canonical' AND session.retired_at IS NULL
           RETURNING session.id
         ) SELECT update_id FROM finished`,
        [updateId, leaseToken, failure.code, failure.message, eveSessionId ?? null],
      );
      return result.rowCount ?? 0;
    });
  },

  async rekeyQueue(input) {
    requireNonEmpty(
      input.previousContinuationKey,
      "AGENT_TELEGRAM_CONTINUATION_INVALID",
      "Не задан предыдущий ключ продолжения Telegram",
    );
    requireNonEmpty(
      input.nextContinuationKey,
      "AGENT_TELEGRAM_CONTINUATION_INVALID",
      "Не задан новый ключ продолжения Telegram",
    );
    requireUuid(
      input.queueId,
      "AGENT_TELEGRAM_QUEUE_ID_INVALID",
      "Идентификатор очереди Telegram имеет некорректный формат",
    );
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const queue = await client.query<{ current_continuation_key: string }>(
        "SELECT current_continuation_key FROM telegram_ingress_queues WHERE id = $1 FOR UPDATE",
        [input.queueId],
      );
      const current = queue.rows[0]?.current_continuation_key;
      if (!current) {
        throw new AppError(
          "AGENT_TELEGRAM_QUEUE_NOT_FOUND",
          "Очередь Telegram для обновления продолжения не найдена",
        );
      }
      const previousAlias = await client.query<{ queue_id: string }>(
        "SELECT queue_id FROM telegram_ingress_continuation_aliases WHERE continuation_key = $1",
        [input.previousContinuationKey],
      );
      if (previousAlias.rows[0]?.queue_id !== input.queueId) {
        throw new AppError(
          "AGENT_TELEGRAM_CONTINUATION_CONFLICT",
          "Предыдущий ключ продолжения Telegram принадлежит другой очереди",
        );
      }
      if (current !== input.previousContinuationKey && current !== input.nextContinuationKey) {
        throw new AppError(
          "AGENT_TELEGRAM_CONTINUATION_STALE",
          "Сессия Telegram уже перешла на другой ключ продолжения. Обновите состояние очереди",
        );
      }

      // A new Telegram bot-message anchor becomes an alias of the original logical queue.
      const nextAlias = await client.query<{ queue_id: string }>(
        "SELECT queue_id FROM telegram_ingress_continuation_aliases WHERE continuation_key = $1",
        [input.nextContinuationKey],
      );
      if (nextAlias.rows[0] && nextAlias.rows[0].queue_id !== input.queueId) {
        throw new AppError(
          "AGENT_TELEGRAM_CONTINUATION_CONFLICT",
          "Новый ключ продолжения Telegram уже принадлежит другой очереди",
        );
      }
      if (!nextAlias.rows[0]) {
        await client.query(
          "INSERT INTO telegram_ingress_continuation_aliases (continuation_key, queue_id) VALUES ($1, $2)",
          [input.nextContinuationKey, input.queueId],
        );
      }
      await client.query(
        `UPDATE telegram_ingress_queues
         SET current_continuation_key = $2, updated_at = now()
         WHERE id = $1`,
        [input.queueId, input.nextContinuationKey],
      );
      await client.query("COMMIT");
    } catch (error) {
      return rollbackAndRethrow(client, error);
    } finally {
      client.release();
    }
  },
};
