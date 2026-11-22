/**
 * Memory subject person migration integration test.
 *
 * Constructs covered:
 * - `157_memory_subject_person.sql` fills a participant's username from the newest raw Telegram update
 *   that person sent to that chat: the journal of a busy group keeps only its newest messages, the raw
 *   updates are kept from the first day. An update without a username means the person has none, and
 *   an update to another chat does not count.
 * - `memory_subject_person` names a group participant by its own row, a family member by their newest
 *   participant row in the family's own chats (never by an external group they also write in), and by
 *   the account itself when there is no such row.
 * - Every active record bound to a person is queued to be embedded again; a label-only record and a
 *   superseded one are not (#556, owner's decision 20.11.2026).
 * - The «indexing stalled» backlog counts only records search cannot find yet: a queued re-index of a
 *   record that has its vector does not raise OsinaraMemoryIndexingStalled.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

const NINA = "701";
const TIMUR = "702";
const GROUP_CHAT = "-100701";
const FAMILY_CHAT = "-100702";

async function migrate(): Promise<void> {
  await database().query(await readFile(resolve("migrations/157_memory_subject_person.sql"), "utf8"));
}

async function person(participantId: string | null, userId: string | null) {
  return (await database().query<{ name: string | null; username: string | null }>(
    "SELECT name, username FROM memory_subject_person($1::uuid, $2::uuid)",
    [participantId, userId],
  )).rows;
}

describeWithDatabase("157_memory_subject_person", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE claim_evidence, memory_items_all, memory_embedding_jobs, telegram_ingress_updates,
         telegram_ingress_queues, telegram_group_messages, telegram_groups, family_memberships, users,
         families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  async function fixture() {
    const familyId = (await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Subject person') RETURNING id",
    )).rows[0]!.id;
    const ninaUserId = (await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name, telegram_username)
       VALUES ($1, 'Нина из приглашения', 'nina_invited') RETURNING id`, [NINA],
    )).rows[0]!.id;
    const quietUserId = (await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name, telegram_username)
       VALUES ('703', 'Пётр', 'petr_p') RETURNING id`,
    )).rows[0]!.id;
    await database().query(
      `INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [familyId, ninaUserId, quietUserId],
    );
    const groups = await database().query<{ id: string; type: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, $2, 'Внешняя', 'external', 'addressed_only'),
              ($1, $3, 'Семья', 'family_private', 'addressed_only')
       RETURNING id, type`,
      [familyId, GROUP_CHAT, FAMILY_CHAT],
    );
    const groupId = groups.rows.find((row) => row.type === "external")!.id;
    const familyGroupId = groups.rows.find((row) => row.type === "family_private")!.id;
    const conversation = await conversationRepository.getByGroupId(groupId);
    const familyConversation = await conversationRepository.getByGroupId(familyGroupId);

    const messages = async (group: string, rows: readonly [number, string, string][]) =>
      (await database().query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (group_id, telegram_message_id, sequence_id, actor_kind, actor_id, telegram_user_id,
            sender_username, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
         SELECT $1, row.n, row.n, 'user', 'telegram:' || row.author, row.author, 'stale_journal',
                row.name, false, 'text', 'Сообщение', now()
         FROM jsonb_to_recordset($2::jsonb) AS row(n integer, author text, name text)
         RETURNING id`,
        [group, JSON.stringify(rows.map(([n, author, name]) => ({ author, n, name })))],
      )).rows.map((row) => row.id);
    await conversationRepository.syncTimelineParticipants(
      conversation.id,
      await messages(groupId, [[1, NINA, "Нина"], [2, TIMUR, "Тимур"]]),
    );
    await conversationRepository.syncTimelineParticipants(
      familyConversation.id,
      await messages(familyGroupId, [[1, NINA, "Нина в семье"]]),
    );
    // As before the migration: nothing has been filled in yet.
    await database().query("UPDATE conversation_participants SET username_snapshot = NULL");

    const queueId = (await database().query<{ id: string }>(
      "INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ('subject-person') RETURNING id",
    )).rows[0]!.id;
    const update = (updateId: number, chat: string, from: string, username: string | null) => ({
      message: {
        chat: { id: Number(chat) },
        from: { id: Number(from), ...(username === null ? {} : { username }) },
        message_id: updateId,
      },
      update_id: updateId,
    });
    const updates = [
      update(1001, GROUP_CHAT, NINA, "nina_s"),
      update(1002, GROUP_CHAT, NINA, "nina_new"),
      update(1003, GROUP_CHAT, TIMUR, "timur_t"),
      update(1004, GROUP_CHAT, TIMUR, null),
      update(1005, "-100999", NINA, "elsewhere"),
      update(1006, FAMILY_CHAT, NINA, "nina_family"),
    ];
    for (const payload of updates) {
      await database().query(
        `INSERT INTO telegram_ingress_updates (update_id, queue_id, ingress_continuation_key, payload)
         VALUES ($1, $2, 'subject-person', $3::jsonb)`,
        [payload.update_id, queueId, JSON.stringify(payload)],
      );
    }
    const participant = async (conversationId: string, telegramUserId: string) =>
      (await database().query<{ id: string }>(
        "SELECT id FROM conversation_participants WHERE conversation_id = $1 AND telegram_user_id = $2",
        [conversationId, telegramUserId],
      )).rows[0]!.id;
    return {
      conversation,
      familyConversation,
      familyId,
      groupId,
      ninaFamilyParticipant: await participant(familyConversation.id, NINA),
      ninaParticipant: await participant(conversation.id, NINA),
      ninaUserId,
      quietUserId,
      timurParticipant: await participant(conversation.id, TIMUR),
    };
  }

  it("fills the username from the newest update the person sent to that chat", async () => {
    const data = await fixture();
    await migrate();

    const usernames = await database().query<{ id: string; username_snapshot: string | null }>(
      "SELECT id, username_snapshot FROM conversation_participants",
    );
    const byId = new Map(usernames.rows.map((row) => [row.id, row.username_snapshot]));
    expect(byId.get(data.ninaParticipant)).toBe("nina_new");
    expect(byId.get(data.timurParticipant)).toBeNull();
    expect(byId.get(data.ninaFamilyParticipant)).toBe("nina_family");
  });

  it("names a participant by its own row and a family member by the family's own chats", async () => {
    const data = await fixture();
    await migrate();

    expect(await person(data.ninaParticipant, null)).toEqual([{ name: "Нина", username: "nina_new" }]);
    expect(await person(data.timurParticipant, null)).toEqual([{ name: "Тимур", username: null }]);
    // The external group's participant of the same person does not name a family record.
    expect(await person(null, data.ninaUserId)).toEqual([{ name: "Нина в семье", username: "nina_family" }]);
    expect(await person(null, data.quietUserId)).toEqual([{ name: "Пётр", username: "petr_p" }]);
    expect(await person(null, null)).toEqual([]);
  });

  it("queues every active record bound to a person, and nothing else", async () => {
    const data = await fixture();
    const record = async (values: {
      label?: string;
      participantId?: string;
      supersededBy?: string;
      userId?: string;
    }) => (await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, scope, group_id, content, source, kind, confirmation, sensitivity,
          operation_key, subject_participant_id, subject_conversation_id, subject_user_id, subject_label,
          claim_status, superseded_by, author_telegram_user_id)
       VALUES ($1, $2::memory_scope, $3, 'Любит Postgres', 'test', 'preference', 'model_high', 'normal',
               gen_random_uuid()::text, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        data.familyId,
        values.userId === undefined ? "group" : "family",
        values.userId === undefined ? data.groupId : null,
        values.participantId ?? null,
        values.participantId === undefined ? null : data.conversation.id,
        values.userId ?? null,
        values.label ?? null,
        values.supersededBy === undefined ? "active" : "superseded",
        values.supersededBy ?? null,
        NINA,
      ],
    )).rows[0]!.id;
    const boundToParticipant = await record({ participantId: data.ninaParticipant });
    const boundToMember = await record({ userId: data.ninaUserId });
    await record({ label: "Тимур (timur_t)" });
    await record({ participantId: data.ninaParticipant, supersededBy: boundToParticipant });
    await database().query("DELETE FROM memory_embedding_jobs");

    await migrate();

    const queued = await database().query<{ memory_item_id: string; status: string }>(
      "SELECT memory_item_id, status FROM memory_embedding_jobs ORDER BY memory_item_id",
    );
    expect(queued.rows).toEqual([boundToParticipant, boundToMember].sort().map((id) => ({
      memory_item_id: id, status: "pending",
    })));
  });

  it("leaves a re-index of an indexed record out of the stall backlog", async () => {
    const data = await fixture();
    const insert = async (status: "indexed" | "pending") => (await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, scope, group_id, content, source, kind, confirmation, sensitivity, operation_key,
          subject_participant_id, subject_conversation_id, author_telegram_user_id, embedding_status)
       VALUES ($1, 'group', $2, 'Любит Postgres', 'test', 'preference', 'model_high', 'normal',
               gen_random_uuid()::text, $3, $4, $5, $6::memory_embedding_status)
       RETURNING id`,
      [data.familyId, data.groupId, data.ninaParticipant, data.conversation.id, NINA, status],
    )).rows[0]!.id;
    await insert("indexed");
    const fresh = await insert("pending");
    await database().query("DELETE FROM memory_embedding_jobs");
    await database().query("INSERT INTO memory_embedding_jobs (memory_item_id) VALUES ($1)", [fresh]);

    await migrate();

    const backlog = await database().query<{ pending: string }>(
      "SELECT pending::text FROM monitoring_memory_embedding_backlog",
    );
    const queued = await database().query<{ n: number }>("SELECT count(*)::integer AS n FROM memory_embedding_jobs");
    expect(queued.rows[0]!.n).toBe(2);
    expect(backlog.rows[0]!.pending).toBe("1");
  });
});
