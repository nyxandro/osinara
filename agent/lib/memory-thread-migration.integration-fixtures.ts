/**
 * Shared setup for memory migration tests that run in an isolated schema.
 *
 * Exports:
 * - `applyMigrationsBefore`: applies every migration ordered before the one under test.
 * - `seedEvidencedThread`: one family group, an evidenced claim and a thread entry built from it,
 *   written with raw SQL against the schema the earlier migrations produced.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

export interface SeededThread {
  readonly claim: string;
  readonly conversation: string;
  readonly family: string;
  readonly thread: string;
  readonly user: string;
}

export async function applyMigrationsBefore(client: PoolClient, migrationName: string): Promise<void> {
  const names = (await readdir(resolve("migrations")))
    .filter((name) => name.endsWith(".sql") && name < migrationName)
    .sort();
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

/** `tag` keeps Telegram identifiers distinct between tests, e.g. 128 → user 128001, chat -100128001. */
export async function seedEvidencedThread(client: PoolClient, tag: number): Promise<SeededThread> {
  const telegramUser = `${tag}001`;
  const family = (await client.query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id", [`Migration ${tag}`],
  )).rows[0]!.id;
  const user = (await client.query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Анна') RETURNING id", [telegramUser],
  )).rows[0]!.id;
  await client.query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [family, user]);
  const group = (await client.query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, 'Семья', 'family_private', 'addressed_only') RETURNING id`,
    [family, `-100${telegramUser}`],
  )).rows[0]!.id;
  const conversation = (await client.query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1", [group],
  )).rows[0]!.id;
  const participant = (await client.query<{ id: string }>(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     VALUES ($1, $2, 'family', $2, $3, $4, 'Анна', now(), now()) RETURNING id`,
    [conversation, family, telegramUser, user],
  )).rows[0]!.id;
  const message = (await client.query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, $3, 1, 'user', $4, $5, 'Анна', false, 'text', 'Подготовка к марафону началась', now())
     RETURNING id`,
    [conversation, group, Number(telegramUser), `telegram:${telegramUser}`, telegramUser],
  )).rows[0]!.id;
  const claim = (await client.query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, author_user_id, scope, kind, content, source, confirmation, sensitivity,
        operation_key, provenance_state, origin_conversation_id, subject_user_id,
        save_approved, content_normalized, profile_eligible)
     VALUES ($1, $2, 'family', 'episode', 'Подготовка к марафону началась', 'agent:test',
             'model_high', 'normal', $4, 'evidenced', $3, $2, false,
             'подготовка к марафону началась', false) RETURNING id`,
    [family, user, conversation, `migration-${tag}-claim`],
  )).rows[0]!.id;
  await client.query(
    `INSERT INTO claim_evidence
       (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
        origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
        author_participant_id, author_user_id, author_label_snapshot, observed_at,
        evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
     VALUES ($1, $2, 'family', $2, 'primary', 'firsthand', $3, 'Семья', $4, $5, $6,
             'Анна', now(), 'Подготовка к марафону началась', $7, 1, $8,
             '{"content":"Подготовка к марафону началась"}'::jsonb)`,
    [claim, family, conversation, group, participant, user, message, Number(telegramUser)],
  );
  const thread = (await client.query<{ id: string }>(
    `INSERT INTO memory_threads (family_id, scope, scope_partition_key, subject_user_id, title, purpose)
     VALUES ($1, 'family', $1, $2, 'Марафон', 'Сохранять подготовку') RETURNING id`,
    [family, user],
  )).rows[0]!.id;
  await client.query(
    `INSERT INTO memory_thread_entries
       (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
     VALUES ($1, $2, 'family', $2, $3, 'goal', now())`,
    [thread, family, claim],
  );
  return { claim, conversation, family, thread, user };
}
