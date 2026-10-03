/**
 * R2a provenance/extraction migration integration tests.
 *
 * Constructs covered:
 * - Migration 051 preserves every pre-existing claim/ref and backfills only Telegram conversations.
 * - Existing claims are active, legacy-unresolved, unendorsed, and receive no invented evidence.
 * - Participant backfill uses timeline Telegram IDs and exact users links, never usernames.
 * - Composite constraints reject cross-zone evidence and more than one primary source.
 * - Timeline pruning nulls only the live FK while bounded provenance metadata survives.
 * - Telegram group erasure cascades conversations, participants, group claims, evidence, and batches.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_r2a_provenance_migration";
const MIGRATION_NAME = "051_r2a_provenance_extraction_foundation.sql";

async function applyMigrationsBefore051(client: import("pg").PoolClient): Promise<void> {
  const names = (await readdir(resolve("migrations")))
    .filter((name) => name.endsWith(".sql") && name < MIGRATION_NAME)
    .sort();
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

describeWithDatabase("051 R2a provenance/extraction migration", () => {
  afterAll(closeDatabase);

  it("backfills exact identities and enforces provenance lifecycle and erasure", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyMigrationsBefore051(client);

      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('R2a migration') RETURNING id",
      );
      const exactUser = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name, telegram_username)
         VALUES ('4701', 'Точная Анна', 'shared_name') RETURNING id`,
      );
      const groups = await client.query<{ id: string; telegram_chat_id: string }>(
        `INSERT INTO telegram_groups
           (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-1004701', 'Первая R2a', 'external', 'addressed_only'),
                ($1, '-1004702', 'Вторая R2a', 'external', 'addressed_only')
         RETURNING id, telegram_chat_id`,
        [family.rows[0]!.id],
      );
      const firstGroup = groups.rows.find((group) => group.telegram_chat_id === "-1004701")!;
      const secondGroup = groups.rows.find((group) => group.telegram_chat_id === "-1004702")!;
      const messages = await client.query<{ group_id: string; id: string; sequence_id: string }>(
        `INSERT INTO telegram_group_messages
           (group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_username, sender_display_name, sender_is_bot,
            message_kind, content_text, message_thread_id, sent_at)
         VALUES ($1, 471, 1, 'user', 'telegram:4701', '4701', 'shared_name', 'Анна', false,
                 'text', 'Проверенный источник', 10, now() - interval '2 minutes'),
                ($1, 472, 2, 'user', 'telegram:4799', '4799', 'shared_name', 'Другая Анна', false,
                 'text', 'Имя не является identity', 20, now() - interval '1 minute'),
                ($1, 473, 3, 'agent_self', 'agent:osinara', NULL, NULL, 'Осинара', true,
                 'text', 'Ответ агента', 20, now()),
                ($2, 474, 1, 'user', 'telegram:4800', '4800', NULL, 'Пётр', false,
                 'text', 'Источник другой зоны', NULL, now())
         RETURNING id, group_id, sequence_id::text`,
        [firstGroup.id, secondGroup.id],
      );
      await client.query(
        `INSERT INTO conversation_sessions
           (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
            continuation_token, started_at, last_activity_at)
         VALUES (gen_random_uuid(), 0, $1, $2, 'group', 'canonical', 'agent-history-only',
                 'r2a-agent-history-token', now(), now())`,
        [family.rows[0]!.id, firstGroup.id],
      );
      const memory = await client.query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, group_id, author_telegram_user_id, scope, kind, content, source,
            confirmation, sensitivity, operation_key)
         VALUES ($1, $2, '4701', 'group', 'fact', 'Старый claim сохраняется точно',
                 'eve:legacy', 'user_confirmed', 'normal', 'legacy-r2a-claim')
         RETURNING id`,
        [family.rows[0]!.id, firstGroup.id],
      );
      const before = await client.query<{
        confirmation: string;
        content: string;
        id: string;
        memory_ref: string;
        operation_key: string;
        source: string;
      }>(
        `SELECT item.id::text, item.content, item.source, item.confirmation::text,
                item.operation_key, ref.memory_ref
         FROM memory_items AS item
         JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
         WHERE item.id = $1`,
        [memory.rows[0]!.id],
      );

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      // New columns do not alter old business fields/ref, nor infer endorsement or source evidence.
      const after = await client.query<{
        claim_status: string;
        confirmation: string;
        content: string;
        endorsed_at: Date | null;
        endorsed_by_user_id: string | null;
        evidence_count: number;
        id: string;
        memory_ref: string;
        operation_key: string;
        provenance_state: string;
        source: string;
      }>(
        `SELECT item.id::text, item.content, item.source, item.confirmation::text,
                item.operation_key, ref.memory_ref, item.claim_status::text,
                item.provenance_state::text, item.endorsed_by_user_id, item.endorsed_at,
                (SELECT count(*)::integer FROM claim_evidence
                 WHERE claim_id = item.id) AS evidence_count
         FROM memory_items AS item
         JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
         WHERE item.id = $1`,
        [memory.rows[0]!.id],
      );
      expect(after.rows[0]).toMatchObject({
        ...before.rows[0],
        claim_status: "active",
        endorsed_at: null,
        endorsed_by_user_id: null,
        evidence_count: 0,
        provenance_state: "legacy_unresolved",
      });

      const conversations = await client.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM application_conversations",
      );
      const participants = await client.query<{
        linked_user_id: string | null;
        telegram_user_id: string;
      }>(
        `SELECT telegram_user_id, linked_user_id FROM conversation_participants
         ORDER BY telegram_user_id`,
      );
      expect(conversations.rows[0]?.count).toBe(2);
      expect(participants.rows).toEqual([
        { linked_user_id: exactUser.rows[0]!.id, telegram_user_id: "4701" },
        { linked_user_id: null, telegram_user_id: "4799" },
        { linked_user_id: null, telegram_user_id: "4800" },
      ]);

      // Membership reactivation must reuse the durable private-chat conversation instead of
      // failing on its unique Telegram identity or replacing its UUID.
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')",
        [family.rows[0]!.id, exactUser.rows[0]!.id],
      );
      const personalConversation = await client.query<{ id: string }>(
        "SELECT id FROM application_conversations WHERE owner_user_id = $1",
        [exactUser.rows[0]!.id],
      );
      await client.query("DELETE FROM family_memberships WHERE user_id = $1", [exactUser.rows[0]!.id]);
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')",
        [family.rows[0]!.id, exactUser.rows[0]!.id],
      );
      await expect(client.query(
        "SELECT id FROM application_conversations WHERE owner_user_id = $1",
        [exactUser.rows[0]!.id],
      )).resolves.toMatchObject({ rows: personalConversation.rows });

      const firstConversation = await client.query<{
        id: string;
        label: string;
        scope_partition_key: string;
      }>(
        `SELECT id, label, scope_partition_key FROM application_conversations
         WHERE telegram_group_id = $1`,
        [firstGroup.id],
      );
      const secondConversation = await client.query<{ id: string; scope_partition_key: string }>(
        `SELECT id, scope_partition_key FROM application_conversations
         WHERE telegram_group_id = $1`,
        [secondGroup.id],
      );
      const firstParticipant = await client.query<{ id: string }>(
        `SELECT id FROM conversation_participants
         WHERE conversation_id = $1 AND telegram_user_id = '4701'`,
        [firstConversation.rows[0]!.id],
      );
      const secondParticipant = await client.query<{ id: string }>(
        `SELECT id FROM conversation_participants
         WHERE conversation_id = $1 AND telegram_user_id = '4800'`,
        [secondConversation.rows[0]!.id],
      );
      const firstMessage = messages.rows.find((message) =>
        message.group_id === firstGroup.id && message.sequence_id === "1"
      )!;
      const secondMessage = messages.rows.find((message) => message.group_id === secondGroup.id)!;

      // Redundant transport identities must agree with the exact application conversation. Neither
      // timeline entries nor aliases may combine a conversation from one group with another group.
      await expect(client.query(
        `INSERT INTO telegram_group_messages
           (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
         VALUES ($1, $2, 9991, 99, 'user', 'telegram:4701', '4701', 'Анна', false,
                 'text', 'Смешанная зона', now())`,
        [firstConversation.rows[0]!.id, secondGroup.id],
      )).rejects.toThrow();
      await expect(client.query(
        `INSERT INTO telegram_group_message_ids
           (conversation_id, group_id, telegram_message_id, entry_id)
         VALUES ($1, $2, 9992, $3)`,
        [firstConversation.rows[0]!.id, secondGroup.id, firstMessage.id],
      )).rejects.toThrow();

      // A source from another group cannot be attached even when family_id is the same.
      await client.query(
        "UPDATE memory_items SET provenance_state = 'evidenced' WHERE id = $1",
        [memory.rows[0]!.id],
      );
      await expect(client.query(
        `INSERT INTO claim_evidence
           (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
            origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
            author_participant_id, observed_at, evidence_snippet, timeline_entry_id,
            timeline_sequence, source_message_id, source_snapshot)
         VALUES ($1, $2, 'group', $3, 'primary', 'firsthand', $4, 'Вторая R2a', $5,
                 $6, now(), 'Чужой источник', $7, 1, 474, '{}'::jsonb)`,
        [memory.rows[0]!.id, family.rows[0]!.id, firstGroup.id,
          secondConversation.rows[0]!.id, secondGroup.id,
          secondParticipant.rows[0]!.id, secondMessage.id],
      )).rejects.toThrow();

      // MATCH SIMPLE must not let a group evidence row bypass conversation/group validation by
      // replacing the required Telegram group component with NULL.
      await expect(client.query(
        `INSERT INTO claim_evidence
           (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
            origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
            author_participant_id, observed_at, evidence_snippet, timeline_sequence, source_snapshot)
         VALUES ($1, $2, 'group', $3, 'primary', 'firsthand', $4, 'Первая R2a', NULL,
                 $5, now(), 'Источник без transport identity', 1, '{}'::jsonb)`,
        [memory.rows[0]!.id, family.rows[0]!.id, firstGroup.id,
          firstConversation.rows[0]!.id, firstParticipant.rows[0]!.id],
      )).rejects.toThrow();

      await client.query(
        `INSERT INTO claim_evidence
           (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
            origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
            author_participant_id, author_user_id, author_label_snapshot, observed_at,
            evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id,
            message_thread_id, source_snapshot)
         VALUES ($1, $2, 'group', $3, 'primary', 'firsthand', $4, $5, $3,
                 $6, $7, 'Анна', now(), 'Проверенный источник', $8, 1, 471, 10,
                 '{"contentHash":"durable","timelineSequence":"1"}'::jsonb)`,
        [memory.rows[0]!.id, family.rows[0]!.id, firstGroup.id,
          firstConversation.rows[0]!.id, firstConversation.rows[0]!.label,
          firstParticipant.rows[0]!.id, exactUser.rows[0]!.id, firstMessage.id],
      );
      await expect(client.query(
        `INSERT INTO claim_evidence
           (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
            origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
            author_participant_id, observed_at, evidence_snippet, timeline_sequence, source_snapshot)
         VALUES ($1, $2, 'group', $3, 'primary', 'firsthand', $4, 'Первая R2a', $3,
                 $5, now(), 'Второй primary', 1, '{}'::jsonb)`,
        [memory.rows[0]!.id, family.rows[0]!.id, firstGroup.id,
          firstConversation.rows[0]!.id, firstParticipant.rows[0]!.id],
      )).rejects.toThrow();

      await client.query("DELETE FROM telegram_group_messages WHERE id = $1", [firstMessage.id]);
      const pruned = await client.query<{
        evidence_snippet: string;
        source_snapshot: Record<string, string>;
        timeline_entry_id: string | null;
        timeline_sequence: string;
      }>(
        `SELECT timeline_entry_id, timeline_sequence::text, evidence_snippet, source_snapshot
         FROM claim_evidence WHERE claim_id = $1`,
        [memory.rows[0]!.id],
      );
      expect(pruned.rows[0]).toMatchObject({
        evidence_snippet: "Проверенный источник",
        source_snapshot: { contentHash: "durable", timelineSequence: "1" },
        timeline_entry_id: null,
        timeline_sequence: "1",
      });

      const batch = await client.query<{ id: string }>(
         `INSERT INTO memory_extraction_batches
            (conversation_id, family_id, scope, scope_partition_key, turn_id,
             extractor_version, schema_version, request_identity_hash, input_payload_hash)
          VALUES ($1, $2, 'group', $3, 'migration-cascade', 'test-v1', 'schema-v1',
                  repeat('a', 64), repeat('b', 64)) RETURNING id`,
        [firstConversation.rows[0]!.id, family.rows[0]!.id, firstGroup.id],
      );
      await client.query("DELETE FROM telegram_groups WHERE id = $1", [firstGroup.id]);
      const cascade = await client.query<{
        batches: number;
        claims: number;
        conversations: number;
        evidence: number;
        participants: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM application_conversations WHERE telegram_group_id = $1) AS conversations,
           (SELECT count(*)::integer FROM conversation_participants WHERE conversation_id = $2) AS participants,
           (SELECT count(*)::integer FROM memory_items WHERE id = $3) AS claims,
           (SELECT count(*)::integer FROM claim_evidence WHERE claim_id = $3) AS evidence,
           (SELECT count(*)::integer FROM memory_extraction_batches WHERE id = $4) AS batches`,
        [firstGroup.id, firstConversation.rows[0]!.id, memory.rows[0]!.id, batch.rows[0]!.id],
      );
      expect(cascade.rows[0]).toEqual({
        batches: 0,
        claims: 0,
        conversations: 0,
        evidence: 0,
        participants: 0,
      });

      // A family-private conversation is erased with its evidence, while the pre-existing family
      // memory lifecycle remains non-destructive and honestly becomes unresolved.
      const familyGroup = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups
           (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-1004703', 'Семейная R2a', 'family_private', 'addressed_only')
         RETURNING id`,
        [family.rows[0]!.id],
      );
      const familyConversation = await client.query<{ id: string }>(
        "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
        [familyGroup.rows[0]!.id],
      );
      const familyMessage = await client.query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_display_name, sender_is_bot, message_kind,
            content_text, sent_at)
         VALUES ($1, 475, 1, 'user', 'telegram:4701', '4701', 'Анна', false,
                 'text', 'Семейный источник', now()) RETURNING id`,
        [familyGroup.rows[0]!.id],
      );
      const familyParticipant = await client.query<{ id: string }>(
        `INSERT INTO conversation_participants
           (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
            linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
         VALUES ($1, $2, 'family', $2, '4701', $3, 'Анна', now(), now()) RETURNING id`,
        [familyConversation.rows[0]!.id, family.rows[0]!.id, exactUser.rows[0]!.id],
      );
      const familyClaim = await client.query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, author_user_id, scope, kind, content, source, confirmation,
            sensitivity, operation_key, provenance_state, origin_conversation_id)
         VALUES ($1, $2, 'family', 'fact', 'Семейный claim переживает удаление чата',
                 'test:family-origin', 'user_confirmed', 'normal', 'family-origin-claim',
                 'evidenced', $3) RETURNING id`,
        [family.rows[0]!.id, exactUser.rows[0]!.id, familyConversation.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO claim_evidence
           (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
            origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
            author_participant_id, author_user_id, author_label_snapshot, observed_at,
            evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
         VALUES ($1, $2, 'family', $2, 'primary', 'firsthand', $3, 'Семейная R2a', $4,
                 $5, $6, 'Анна', now(), 'Семейный источник', $7, 1, 475, '{}'::jsonb)`,
        [familyClaim.rows[0]!.id, family.rows[0]!.id, familyConversation.rows[0]!.id,
          familyGroup.rows[0]!.id, familyParticipant.rows[0]!.id,
          exactUser.rows[0]!.id, familyMessage.rows[0]!.id],
      );
      await client.query("DELETE FROM telegram_groups WHERE id = $1", [familyGroup.rows[0]!.id]);
      const survivingFamilyClaim = await client.query<{
        evidence_count: number;
        origin_conversation_id: string | null;
        provenance_state: string;
      }>(
        `SELECT provenance_state::text, origin_conversation_id,
                (SELECT count(*)::integer FROM claim_evidence
                 WHERE claim_id = memory_items.id) AS evidence_count
         FROM memory_items WHERE id = $1`,
        [familyClaim.rows[0]!.id],
      );
      expect(survivingFamilyClaim.rows[0]).toEqual({
        evidence_count: 0,
        origin_conversation_id: null,
        provenance_state: "legacy_unresolved",
      });
    } finally {
      try {
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        client.release();
      }
    }
  });
});
