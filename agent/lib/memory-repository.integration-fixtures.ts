/**
 * PostgreSQL long-term memory repository integration fixtures.
 *
 * Exports:
 * - `INVALID_SOURCE`: deterministic nonexistent evidence identifiers.
 * - `createMemoryFamilyFixture`: creates one family, owner, member, and family chat.
 * - `createMemoryCorrectionSource`: records a real timeline source for correction tests.
 * - `createMemoryInput`: builds a deterministic memory create command.
 */
import { expect } from "vitest";

import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";

interface FamilyFixture {
  familyId: string;
  member: MemoryAuthorization;
  owner: MemoryAuthorization;
}

export const INVALID_SOURCE = {
  conversationId: "00000000-0000-4000-8000-000000000090",
  timelineEntryId: "00000000-0000-4000-8000-000000000091",
};

export async function createMemoryFamilyFixture(suffix: string): Promise<FamilyFixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Семья ${suffix}`],
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, $2), ($3, $4)
     RETURNING id, telegram_user_id`,
    [`owner-${suffix}`, `Владелец ${suffix}`, `member-${suffix}`, `Участник ${suffix}`],
  );
  const owner = users.rows.find((row) => row.telegram_user_id === `owner-${suffix}`)!;
  const member = users.rows.find((row) => row.telegram_user_id === `member-${suffix}`)!;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, owner.id, member.id],
  );
  await database().query(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, $3, 'family_private', 'addressed_only')`,
    [family.rows[0]!.id, `family-${suffix}`, `Семейный чат ${suffix}`],
  );
  return {
    familyId: family.rows[0]!.id,
    member: {
      familyId: family.rows[0]!.id, groupId: null, role: "member", scopes: ["personal", "family"],
      telegramActorId: member.telegram_user_id, telegramActorKind: "telegram_user",
      telegramUserId: member.telegram_user_id,
      userId: member.id,
    },
    owner: {
      familyId: family.rows[0]!.id, groupId: null, role: "owner", scopes: ["personal", "family"],
      telegramActorId: owner.telegram_user_id, telegramActorKind: "telegram_user",
      telegramUserId: owner.telegram_user_id,
      userId: owner.id,
    },
  };
}

export async function createMemoryCorrectionSource(
  auth: MemoryAuthorization,
  scope: "family" | "personal",
): Promise<{ conversationId: string; timelineEntryId: string }> {
  const conversation = await database().query<{
    id: string;
    sequence_id: string;
    telegram_group_id: string | null;
  }>(
    `UPDATE application_conversations
     SET next_timeline_sequence = next_timeline_sequence + 1
     WHERE family_id = $1 AND scope = $2
       AND ($2 = 'family' OR owner_user_id = $3)
     RETURNING id, telegram_group_id, next_timeline_sequence::text AS sequence_id`,
    [auth.familyId, scope, auth.userId],
  );
  const current = conversation.rows[0]!;
  const participant = await database().query<{ id: string }>(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'Автор исправления', now(), now())
     ON CONFLICT (conversation_id, telegram_user_id) DO UPDATE SET last_observed_at = now()
     RETURNING id`,
    [current.id, auth.familyId, scope, scope === "family" ? auth.familyId : auth.userId,
      auth.telegramUserId, auth.userId],
  );
  expect(participant.rows[0]).toBeDefined();
  const entry = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, $3, $3, 'user', $4, $5, 'Автор исправления', false, 'text',
             'Исправь эту запись памяти', now()) RETURNING id`,
    [current.id, current.telegram_group_id, current.sequence_id,
      `telegram:${auth.telegramUserId}`, auth.telegramUserId],
  );
  return { conversationId: current.id, timelineEntryId: entry.rows[0]!.id };
}

export function createMemoryInput(
  scope: "family" | "group" | "personal",
  operationKey: string,
  content = "Пользователь предпочитает короткие ответы",
  provenance = { sessionId: "session-current", turnId: "turn-current" },
) {
  return {
    confirmation: "user_confirmed" as const,
    content,
    kind: "preference" as const,
    operationKey,
    provenance,
    scope,
    sensitivity: "normal" as const,
    source: `turn:session:${operationKey}`,
  };
}
