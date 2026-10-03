/**
 * PostgreSQL storage for one user-managed operational prompt per Telegram chat.
 *
 * Exports:
 * - `BehaviorPreferenceMutation`: append, replace, or clear with optimistic revision.
 * - `behaviorPreferenceRepository`: live-authorized get and mutate operations.
 *
 * Key constructs:
 * - Exact chat and actor come only from the verified current Telegram timeline entry.
 * - One row lock and `expectedRevision` prevent silent lost updates.
 * - The last source/hash pair makes an exact replay of the tool call idempotent.
 */
import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type {
  BehaviorPreferenceAuthorization,
  BehaviorPreferenceReadAuthorization,
  BehaviorPreferenceBoundChatReadAuthorization,
} from "./behavior-preference-context.js";
import {
  type ChatOperationalPrompt,
  requireChatOperationalPromptText,
} from "./behavior-preferences.js";
import { database } from "./database.js";

export type BehaviorPreferenceMutation =
  | { action: "append" | "replace"; content: string; expectedRevision: number }
  | { action: "clear"; expectedRevision: number };

interface PromptRow {
  content: string;
  last_operation_hash: string;
  last_source_sequence: string;
  revision: number;
  updated_at: Date;
}

interface AuthorizedBoundary {
  actorUserId: string | null;
  familyId: string;
}

async function requireBoundChatReadBoundary(
  client: PoolClient,
  auth: BehaviorPreferenceBoundChatReadAuthorization,
): Promise<string> {
  const conversation = await client.query<{
    id: string;
    owner_user_id: string | null;
    scope: "family" | "group" | "personal";
    telegram_group_id: string | null;
  }>(
    `SELECT id, owner_user_id, scope, telegram_group_id
     FROM application_conversations
     WHERE family_id = $1 AND telegram_chat_id = $2
     FOR SHARE`,
    [auth.familyId, auth.telegramChatId],
  );
  const row = conversation.rows[0];
  const expectedOwner = auth.scope === "personal" ? auth.actorUserId : null;
  if (
    !row ||
    row.scope !== auth.scope ||
    row.owner_user_id !== expectedOwner ||
    row.telegram_group_id !== auth.groupId
  ) {
    throw new AppError(
      "AGENT_BEHAVIOR_PREFERENCE_ACCESS_DENIED",
      "Не удалось подтвердить чат для применения оперативных инструкций",
    );
  }

  // Scheduled and approval continuations are read-only and still require live family membership.
  const membership = await client.query(
    "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 FOR SHARE",
    [auth.familyId, auth.actorUserId],
  );
  if (membership.rowCount !== 1) {
    throw new AppError(
      "AGENT_BEHAVIOR_PREFERENCE_ACCESS_DENIED",
      "Доступ участника к этому чату был отозван",
    );
  }

  if (auth.scope !== "personal") {
    const expectedType = auth.scope === "family" ? "family_private" : "external";
    const group = await client.query(
      `SELECT 1 FROM telegram_groups
       WHERE id = $1 AND family_id = $2 AND telegram_chat_id = $3 AND type = $4 FOR SHARE`,
      [auth.groupId, auth.familyId, auth.telegramChatId, expectedType],
    );
    if (group.rowCount !== 1) {
      throw new AppError(
        "AGENT_BEHAVIOR_PREFERENCE_ACCESS_DENIED",
        "Этот Telegram-чат больше не зарегистрирован",
      );
    }
  }
  return row.id;
}

async function requireLiveBoundary(
  client: PoolClient,
  auth: BehaviorPreferenceAuthorization,
  lockConversation = false,
): Promise<AuthorizedBoundary> {
  const source = await client.query<{
    actor_user_id: string | null;
    family_id: string;
    owner_user_id: string | null;
    scope: "family" | "group" | "personal";
    telegram_group_id: string | null;
  }>(
    `SELECT app_user.id AS actor_user_id, conversation.family_id, conversation.owner_user_id,
            conversation.scope, conversation.telegram_group_id
     FROM application_conversations AS conversation
     JOIN telegram_group_messages AS source
       ON source.id = $2
      AND source.conversation_id = conversation.id
      AND source.sequence_id = $3::bigint
      AND source.actor_kind IN ('user', 'telegram_bot')
      AND source.telegram_user_id = $4
     LEFT JOIN users AS app_user ON app_user.telegram_user_id = source.telegram_user_id
     WHERE conversation.id = $1
     ${lockConversation ? "FOR UPDATE OF conversation" : ""}`,
    [auth.conversationId, auth.timelineEntryId, auth.sourceSequence, auth.telegramUserId],
  );
  const row = source.rows[0];
  if (!row || (row.scope === "personal" && row.owner_user_id !== row.actor_user_id)) {
    throw new AppError(
      "AGENT_BEHAVIOR_PREFERENCE_ACCESS_DENIED",
      "Не удалось подтвердить доступ к оперативным инструкциям этого чата",
    );
  }

  // Locks keep membership or group registration live through the read/write transaction.
  if (row.scope !== "group") {
    const membership = await client.query(
      "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 FOR SHARE",
      [row.family_id, row.actor_user_id],
    );
    if (membership.rowCount !== 1) {
      throw new AppError(
        "AGENT_BEHAVIOR_PREFERENCE_ACCESS_DENIED",
        "Доступ участника к этому чату был отозван",
      );
    }
  }
  if (row.scope !== "personal") {
    const expectedType = row.scope === "family" ? "family_private" : "external";
    const group = await client.query(
      "SELECT 1 FROM telegram_groups WHERE id = $1 AND family_id = $2 AND type = $3 FOR SHARE",
      [row.telegram_group_id, row.family_id, expectedType],
    );
    if (group.rowCount !== 1) {
      throw new AppError(
        "AGENT_BEHAVIOR_PREFERENCE_ACCESS_DENIED",
        "Этот Telegram-чат больше не зарегистрирован",
      );
    }
  }
  return { actorUserId: row.actor_user_id, familyId: row.family_id };
}

function operationHash(input: BehaviorPreferenceMutation): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function project(row: PromptRow | undefined): ChatOperationalPrompt {
  return row
    ? { content: row.content, revision: row.revision, updatedAt: row.updated_at.toISOString() }
    : { content: "", revision: 0, updatedAt: null };
}

function nextContent(current: string, input: BehaviorPreferenceMutation): string {
  if (input.action === "clear") return "";
  if (input.action === "replace") return requireChatOperationalPromptText(input.content);
  const addition = requireChatOperationalPromptText(input.content);
  return requireChatOperationalPromptText(current.length === 0 ? addition : `${current}\n${addition}`);
}

async function currentPrompt(client: PoolClient, conversationId: string, lock = false) {
  const result = await client.query<PromptRow>(
    `SELECT content, revision, last_source_sequence::text, last_operation_hash, updated_at
     FROM behavior_preferences
     WHERE conversation_id = $1${lock ? " FOR UPDATE" : ""}`,
    [conversationId],
  );
  return result.rows[0];
}

export const behaviorPreferenceRepository = {
  async get(auth: BehaviorPreferenceReadAuthorization): Promise<ChatOperationalPrompt> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const conversationId = "kind" in auth
        ? await requireBoundChatReadBoundary(client, auth)
        : (await requireLiveBoundary(client, auth), auth.conversationId);
      const row = await currentPrompt(client, conversationId);
      await client.query("COMMIT");
      return project(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async mutate(
    auth: BehaviorPreferenceAuthorization,
    input: BehaviorPreferenceMutation,
  ): Promise<ChatOperationalPrompt> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
       // The conversation row exists before the prompt row and serializes concurrent first writes.
       const boundary = await requireLiveBoundary(client, auth, true);
      const current = await currentPrompt(client, auth.conversationId, true);
      const hash = operationHash(input);

      // Durable replay of the exact tool result returns the already committed prompt unchanged.
      if (
        current?.last_source_sequence === auth.sourceSequence &&
        current.last_operation_hash === hash
      ) {
        await client.query("COMMIT");
        return project(current);
      }
      if ((current?.revision ?? 0) !== input.expectedRevision) {
        throw new AppError(
          "AGENT_BEHAVIOR_PREFERENCE_REVISION_CONFLICT",
          `Оперативные инструкции уже изменились. Текущая revision: ${current?.revision ?? 0}`,
        );
      }
      if (current && BigInt(auth.sourceSequence) <= BigInt(current.last_source_sequence)) {
        throw new AppError(
          "AGENT_BEHAVIOR_PREFERENCE_REVISION_CONFLICT",
          "Более новое сообщение уже изменило оперативные инструкции",
        );
      }

      const content = nextContent(current?.content ?? "", input);
      const revision = (current?.revision ?? 0) + 1;
      const saved = await client.query<PromptRow>(
        `INSERT INTO behavior_preferences
           (conversation_id, content, revision, last_source_timeline_entry_id,
            last_source_sequence, last_updated_by_telegram_user_id, last_operation_hash)
         VALUES ($1, $2, $3, $4, $5::bigint, $6, $7)
         ON CONFLICT (conversation_id) DO UPDATE
         SET content = EXCLUDED.content,
             revision = EXCLUDED.revision,
             last_source_timeline_entry_id = EXCLUDED.last_source_timeline_entry_id,
             last_source_sequence = EXCLUDED.last_source_sequence,
             last_updated_by_telegram_user_id = EXCLUDED.last_updated_by_telegram_user_id,
             last_operation_hash = EXCLUDED.last_operation_hash,
             updated_at = now()
         RETURNING content, revision, last_source_sequence::text,
                   last_operation_hash, updated_at`,
        [auth.conversationId, content, revision, auth.timelineEntryId,
          auth.sourceSequence, auth.telegramUserId, hash],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'chat_operational_instructions_updated', $3,
                 jsonb_build_object('action', $4::text, 'revision', $5::integer,
                                    'sourceSequence', $6::text))`,
        [boundary.familyId, boundary.actorUserId, auth.conversationId,
          input.action, revision, auth.sourceSequence],
      );
      await client.query("COMMIT");
      return project(saved.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
