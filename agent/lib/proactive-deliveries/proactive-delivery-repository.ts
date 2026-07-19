/**
 * PostgreSQL proactive delivery journal.
 *
 * Exports:
 * - `ProactiveDeliveryAuthorization`: exact personal or family trust-zone selector.
 * - `ProactiveDeliveryInput`: successful Telegram delivery persistence contract.
 * - `ProactiveDeliveryReceipt`: Telegram message identity and delivered text.
 * - `recordProactiveDelivery`: transaction-composable insertion helper.
 * - `proactiveDeliveryRepository`: context cursor, history search, and standalone recording.
 */
import type { Pool, PoolClient } from "pg";

import {
  PROACTIVE_DELIVERY_CONTEXT_MAX_AGE_DAYS,
  PROACTIVE_DELIVERY_CONTEXT_MAX_CHARACTERS,
  PROACTIVE_DELIVERY_CONTEXT_MAX_ITEMS,
  PROACTIVE_DELIVERY_HISTORY_MAX_ITEMS,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  formatProactiveDeliveryContext,
  type ProactiveDeliveryRecord,
  type ProactiveDeliverySourceKind,
} from "./proactive-delivery-context.js";

export interface ProactiveDeliveryAuthorization {
  familyId: string;
  groupId: string | null;
  messageThreadId: string | null;
  ownerUserId: string | null;
  scope: "family" | "personal";
  telegramChatId: string;
}

export interface ProactiveDeliveryInput extends ProactiveDeliveryAuthorization {
  content: string;
  deliveredAt: Date;
  scheduledFor: Date;
  sourceId: string;
  sourceKind: ProactiveDeliverySourceKind;
  telegramMessageId: string;
  title: string | null;
}

export interface ProactiveDeliveryReceipt {
  messageId: string;
  text: string;
}

interface DeliveryRow {
  content_text: string;
  delivered_at: Date;
  id: string;
  scheduled_for: Date;
  source_kind: ProactiveDeliverySourceKind;
  title: string | null;
}

type QueryClient = Pool | PoolClient;

function requirePositiveBigint(value: string, field: string): string {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new AppError(
      "AGENT_PROACTIVE_DELIVERY_INVALID",
      `Не удалось сохранить доставку: поле ${field} должно быть положительным идентификатором`,
    );
  }
  return value;
}

function requireAuthorization(input: ProactiveDeliveryAuthorization): void {
  const validPersonal = input.scope === "personal" && input.ownerUserId !== null &&
    input.groupId === null && input.messageThreadId === null;
  const validFamily = input.scope === "family" && input.ownerUserId === null &&
    input.groupId !== null;
  if (!validPersonal && !validFamily) {
    throw new AppError(
      "AGENT_PROACTIVE_DELIVERY_SCOPE_INVALID",
      "Не удалось определить область истории уведомлений",
    );
  }
}

function requireDelivery(input: ProactiveDeliveryInput): void {
  requireAuthorization(input);
  requirePositiveBigint(input.telegramMessageId, "telegramMessageId");
  if (
    !input.content.trim() ||
    !(input.deliveredAt instanceof Date) ||
    Number.isNaN(input.deliveredAt.getTime()) ||
    !(input.scheduledFor instanceof Date) ||
    Number.isNaN(input.scheduledFor.getTime())
  ) {
    throw new AppError(
      "AGENT_PROACTIVE_DELIVERY_INVALID",
      "Не удалось сохранить доставку: отсутствует текст или корректное время",
    );
  }
}

function mapRows(rows: readonly DeliveryRow[]): ProactiveDeliveryRecord[] {
  return rows.map((row) => ({
    content: row.content_text,
    deliveredAt: row.delivered_at.toISOString(),
    id: row.id,
    scheduledFor: row.scheduled_for.toISOString(),
    sourceKind: row.source_kind,
    title: row.title,
  }));
}

export async function recordProactiveDelivery(
  client: QueryClient,
  input: ProactiveDeliveryInput,
): Promise<void> {
  requireDelivery(input);
  await client.query(
    `INSERT INTO proactive_deliveries
       (family_id, owner_user_id, group_id, scope, source_kind, source_id, title,
        content_text, scheduled_for, delivered_at, telegram_chat_id,
        message_thread_id, telegram_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (source_kind, source_id, telegram_message_id) DO NOTHING`,
    [
      input.familyId,
      input.ownerUserId,
      input.groupId,
      input.scope,
      input.sourceKind,
      input.sourceId,
      input.title,
      input.content.trim(),
      input.scheduledFor,
      input.deliveredAt,
      input.telegramChatId,
      input.messageThreadId,
      input.telegramMessageId,
    ],
  );
}

export const proactiveDeliveryRepository = {
  async record(input: ProactiveDeliveryInput): Promise<void> {
    await recordProactiveDelivery(database(), input);
  },

  async listPendingContext(
    input: ProactiveDeliveryAuthorization & { applicationSessionId: string; now: Date },
  ): Promise<{ context: string; cursor: string } | null> {
    requireAuthorization(input);
    if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
      throw new AppError(
        "AGENT_PROACTIVE_CONTEXT_TIME_INVALID",
        "Не удалось определить время для истории уведомлений",
      );
    }

    // The application session must itself own the requested trust zone before any journal read.
    const session = await database().query<{ last_proactive_delivery_id: string }>(
      `SELECT last_proactive_delivery_id::text
         FROM conversation_sessions
        WHERE id = $1 AND retired_at IS NULL AND family_id = $2 AND scope = $3
          AND owner_user_id IS NOT DISTINCT FROM $4::uuid
          AND group_id IS NOT DISTINCT FROM $5::uuid`,
      [input.applicationSessionId, input.familyId, input.scope, input.ownerUserId, input.groupId],
    );
    const cursor = session.rows[0]?.last_proactive_delivery_id;
    if (cursor === undefined) {
      throw new AppError(
        "AGENT_PROACTIVE_CONTEXT_SESSION_INVALID",
        "Текущий разговор не соответствует области истории уведомлений",
      );
    }

    // Select newest unseen rows first for a hard bound, then restore delivery chronology.
    const result = await database().query<DeliveryRow>(
      `SELECT * FROM (
         SELECT id::text, source_kind, title, content_text, scheduled_for, delivered_at
           FROM proactive_deliveries
          WHERE id > $1::bigint AND family_id = $2 AND scope = $3
            AND owner_user_id IS NOT DISTINCT FROM $4::uuid
            AND group_id IS NOT DISTINCT FROM $5::uuid
            AND telegram_chat_id = $6
            AND message_thread_id IS NOT DISTINCT FROM $7::bigint
            AND delivered_at <= $8
            AND delivered_at >= $8 - ($9::text || ' days')::interval
          ORDER BY id DESC
          LIMIT $10
       ) AS recent ORDER BY id::bigint ASC`,
      [
        cursor,
        input.familyId,
        input.scope,
        input.ownerUserId,
        input.groupId,
        input.telegramChatId,
        input.messageThreadId,
        input.now,
        PROACTIVE_DELIVERY_CONTEXT_MAX_AGE_DAYS,
        PROACTIVE_DELIVERY_CONTEXT_MAX_ITEMS,
      ],
    );
    const records = mapRows(result.rows);
    if (records.length === 0) return null;
    const context = formatProactiveDeliveryContext(
      records,
      PROACTIVE_DELIVERY_CONTEXT_MAX_CHARACTERS,
    );
    if (!context) return null;
    return { context, cursor: records.at(-1)!.id };
  },

  async advanceSessionCursor(applicationSessionId: string, cursor: string): Promise<void> {
    requirePositiveBigint(cursor, "cursor");
    const result = await database().query(
      `UPDATE conversation_sessions
          SET last_proactive_delivery_id = greatest(last_proactive_delivery_id, $2::bigint)
        WHERE id = $1 AND retired_at IS NULL`,
      [applicationSessionId, cursor],
    );
    if (result.rowCount !== 1) {
      throw new AppError(
        "AGENT_PROACTIVE_CONTEXT_SESSION_INVALID",
        "Не удалось подтвердить историю уведомлений для текущего разговора",
      );
    }
  },

  async list(
    input: ProactiveDeliveryAuthorization & {
      query: string | null;
      sourceKind: ProactiveDeliverySourceKind | null;
    },
  ): Promise<ProactiveDeliveryRecord[]> {
    requireAuthorization(input);
    const result = await database().query<DeliveryRow>(
      `SELECT id::text, source_kind, title, content_text, scheduled_for, delivered_at
         FROM proactive_deliveries
        WHERE family_id = $1 AND scope = $2
          AND owner_user_id IS NOT DISTINCT FROM $3::uuid
          AND group_id IS NOT DISTINCT FROM $4::uuid
          AND telegram_chat_id = $5
          AND message_thread_id IS NOT DISTINCT FROM $6::bigint
          AND ($7::proactive_delivery_source_kind IS NULL OR source_kind = $7)
          AND ($8::text IS NULL OR search_vector @@ websearch_to_tsquery('russian', $8))
        ORDER BY delivered_at DESC, id DESC
        LIMIT $9`,
      [
        input.familyId,
        input.scope,
        input.ownerUserId,
        input.groupId,
        input.telegramChatId,
        input.messageThreadId,
        input.sourceKind,
        input.query,
        PROACTIVE_DELIVERY_HISTORY_MAX_ITEMS,
      ],
    );
    return mapRows(result.rows);
  },
};
