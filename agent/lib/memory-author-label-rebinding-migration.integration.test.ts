/**
 * Author label rebinding migration integration test.
 *
 * Constructs covered:
 * - `134_memory_author_label_rebinding.sql`: a stored fact whose label is just the name of the
 *   author of its own source message becomes a fact about that verified author: it enters the
 *   profile, loses the text label, and is queued to be embedded again without its old header.
 * - The author is recognised by display name, by username, and by "display (username)", whatever the
 *   case and spacing, also when the source message itself is gone and the username comes from
 *   another of the author's messages.
 * - A bare name another participant of the chat also carries stays a text label.
 * - Every rebound record leaves its previous label in the audit log.
 * - A label naming someone else, the author plus a topic, and a deleted record stay as they were.
 * - Personal memory: the owner written by name becomes the owner's own verified subject.
 * - `updated_at` does not move: the text did not change, and the model reads updatedAt as an edit.
 *
 * On production 1 203 group records about 125 people fit the rule on 17.10.2026.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ToolContext } from "../runtime/tool.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";
import { memoryRepository } from "./memory-repository.js";
import {
  createMemoryCorrectionSource,
  createMemoryFamilyFixture,
  createMemoryInput,
} from "./memory-repository.integration-fixtures.js";
import { bindMemoryTurnSources, releaseMemoryTurnSources } from "./memory-turn-source.js";
import remember from "./tools/remember.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;
const ANNA_ID = "7300000001";
const BORIS_ID = "7300000002";

/** Four messages: 1, 3, 4 by Анна (anna_k), 2 by Борис (boris_b); the turn answers message 4. */
async function fixture() {
  const familyId = (await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Label rebinding') RETURNING id",
  )).rows[0]!.id;
  const ownerId = (await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Анна') RETURNING id", [ANNA_ID],
  )).rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id,user_id,role) VALUES ($1,$2,'owner')", [familyId, ownerId],
  );
  const groupId = (await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id,telegram_chat_id,title,type,message_mode,tool_allowlist)
     VALUES ($1,'-100-label-rebinding','Label rebinding','external','addressed_only',ARRAY['remember'])
     RETURNING id`, [familyId],
  )).rows[0]!.id;
  const conversationId = (await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id=$1", [groupId],
  )).rows[0]!.id;
  const entries = (await database().query<{ id: string; sequence_id: string }>(
    `INSERT INTO telegram_group_messages
      (conversation_id,group_id,telegram_message_id,sequence_id,actor_kind,actor_id,telegram_user_id,
       sender_username,sender_display_name,sender_is_bot,message_kind,content_text,sent_at)
     SELECT $1,$2,n,n,'user','telegram:'||CASE WHEN n=2 THEN $4 ELSE $3 END,
       CASE WHEN n=2 THEN $4 ELSE $3 END, CASE WHEN n=2 THEN 'boris_b' ELSE 'anna_k' END,
       CASE WHEN n=2 THEN 'Борис' ELSE 'Анна' END,false,'text','Сообщение '||n,now()
     FROM generate_series(1,4) n RETURNING id,sequence_id::text`,
    [conversationId, groupId, ANNA_ID, BORIS_ID],
  )).rows.sort((a, b) => Number(a.sequence_id) - Number(b.sequence_id));
  await conversationRepository.syncTimelineParticipants(conversationId, entries.map((entry) => entry.id));
  const sessionId = (await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
     (thread_id,generation,family_id,group_id,scope,kind,conversation_key,continuation_token,started_at,last_activity_at)
     VALUES (gen_random_uuid(),0,$1,$2,'group','canonical','label-rebinding','label-rebinding',now(),now())
     RETURNING id`,
    [familyId, groupId],
  )).rows[0]!.id;
  const ctx = {
    callId: "unused", session: {
      id: "agent-label-rebinding", turn: { id: "turn_0" }, auth: { initiator: null, current: {
        authenticator: "telegram", principalId: ownerId, principalType: "user",
        attributes: {
          applicationSessionId: sessionId, familyId, groupId, groupType: "external", role: "external",
          memoryScopes: ["group"], telegramActorId: ANNA_ID, telegramActorKind: "telegram_user",
          telegramUserId: ANNA_ID, telegramConversationId: conversationId,
          telegramTimelineEntryId: entries[3]!.id,
          telegramTimelineVisibleEntryIds: entries.map((entry) => entry.id),
        },
      } },
    },
  } as unknown as ToolContext;
  await bindMemoryTurnSources(ctx);
  return { conversationId, ctx, entries };
}

/** Saves a fact through the real path, then gives it the subject a record written before 17.10 had. */
async function legacyRecord(
  ctx: ToolContext,
  key: string,
  sourceSequence: string,
  label: string,
): Promise<string> {
  const saved = await remember.execute({
    basis: "agent_inferred", content: `Факт ${key}`, kind: "fact", scope: "group",
    sensitivity: "normal", sourceSequence, subject: { kind: "none" },
  }, { ...ctx, callId: key }) as { item: { memoryRef: string } };
  const row = await database().query<{ id: string }>(
    `UPDATE memory_items_all SET subject_label = $2, profile_eligible = false
     WHERE operation_key = $1 RETURNING id`,
    [key, label],
  );
  expect(saved.item.memoryRef).toBeTruthy();
  return row.rows[0]!.id;
}

async function stateOf(id: string) {
  const row = await database().query<{
    jobs: number;
    profile_eligible: boolean;
    subject_label: string | null;
    subject_telegram_id: string | null;
    subject_user_id: string | null;
    updated_moved: boolean;
  }>(
    `SELECT item.subject_label, item.profile_eligible, item.subject_user_id,
            participant.telegram_user_id AS subject_telegram_id,
            item.updated_at <> marker.updated_at AS updated_moved,
            (SELECT count(*)::integer FROM memory_embedding_jobs WHERE memory_item_id = item.id) AS jobs
     FROM memory_items_all AS item
     JOIN label_rebinding_marker AS marker ON marker.id = item.id
     LEFT JOIN conversation_participants AS participant ON participant.id = item.subject_participant_id
     WHERE item.id = $1`,
    [id],
  );
  return row.rows[0]!;
}

describeWithDatabase("134 author label rebinding", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users,families CASCADE");
    await database().query("DROP TABLE IF EXISTS label_rebinding_marker");
  });
  afterAll(async () => {
    await database().query("DROP TABLE IF EXISTS label_rebinding_marker");
    await closeDatabase();
  });

  it("binds every fact signed with its author's own name and leaves the rest alone", async () => {
    const { ctx, entries } = await fixture();
    const byUsernameAndName = await legacyRecord(ctx, "anna-full", "1", "Анна (anna_k)");
    const byUsername = await legacyRecord(ctx, "boris-username", "2", "@boris_b");
    const byName = await legacyRecord(ctx, "anna-name", "3", "Анна");
    const respelled = await legacyRecord(ctx, "anna-respelled", "3", "анна\u00a0 (ANNA_K)");
    const sourceGone = await legacyRecord(ctx, "anna-source-gone", "1", "Анна (@anna_k)");
    const someoneElse = await legacyRecord(ctx, "other-person", "3", "Борис (boris_b)");
    const withTopic = await legacyRecord(ctx, "author-topic", "3", "Анна (anna_k) — проект");
    const deleted = await legacyRecord(ctx, "deleted", "3", "Анна (anna_k)");
    await database().query(
      "UPDATE memory_items_all SET claim_status = 'retracted', deleted_at = now() WHERE id = $1", [deleted],
    );
    // The turn is over, and message 1 is past the retention window: its author's username survives
    // on message 3.
    await releaseMemoryTurnSources(ctx);
    await database().query("DELETE FROM telegram_group_messages WHERE id = $1", [entries[0]!.id]);
    // Indexed long ago, so no job is waiting; the snapshot tells a moved updated_at.
    await database().query("DELETE FROM memory_embedding_jobs");
    await database().query("UPDATE memory_items_all SET embedding_status = 'indexed'");
    await database().query(
      "CREATE TABLE label_rebinding_marker AS SELECT id, updated_at FROM memory_items_all",
    );

    await database().query(
      await readFile(resolve("migrations/134_memory_author_label_rebinding.sql"), "utf8"),
    );

    const bound = (telegramId: string) => ({
      jobs: 1, profile_eligible: true, subject_label: null, subject_telegram_id: telegramId,
      subject_user_id: null, updated_moved: false,
    });
    expect(await stateOf(byUsernameAndName)).toEqual(bound(ANNA_ID));
    expect(await stateOf(byUsername)).toEqual(bound(BORIS_ID));
    expect(await stateOf(byName)).toEqual(bound(ANNA_ID));
    expect(await stateOf(sourceGone)).toEqual(bound(ANNA_ID));
    expect(await stateOf(respelled)).toEqual(bound(ANNA_ID));
    const untouched = (label: string) => ({
      jobs: 0, profile_eligible: false, subject_label: label, subject_telegram_id: null,
      subject_user_id: null, updated_moved: false,
    });
    expect(await stateOf(someoneElse)).toEqual(untouched("Борис (boris_b)"));
    expect(await stateOf(withTopic)).toEqual(untouched("Анна (anna_k) — проект"));
    expect(await stateOf(deleted)).toEqual(untouched("Анна (anna_k)"));
    const audit = await database().query<{ previous_label: string }>(
      `SELECT metadata->>'previousLabel' AS previous_label FROM audit_events
       WHERE event_type = 'memory.subject_label_rebound' AND subject_id = $1`,
      [byUsernameAndName],
    );
    expect(audit.rows).toEqual([{ previous_label: "Анна (anna_k)" }]);
    await expect(database().query(
      "SELECT count(*)::integer AS n FROM audit_events WHERE event_type = 'memory.subject_label_rebound'",
    )).resolves.toMatchObject({ rows: [{ n: 5 }] });
  });

  it("keeps a bare name another participant of the chat also carries", async () => {
    const { conversationId, ctx } = await fixture();
    const byName = await legacyRecord(ctx, "anna-name", "3", "Анна");
    const byUsername = await legacyRecord(ctx, "anna-full", "3", "Анна (anna_k)");
    // A second «Анна» in the same chat: the name alone no longer says which one is meant.
    await database().query(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          display_name_snapshot, first_observed_at, last_observed_at)
       SELECT id, family_id, scope, scope_partition_key, '7300000003', 'Анна', now(), now()
       FROM application_conversations WHERE id = $1`,
      [conversationId],
    );
    await database().query("DELETE FROM memory_embedding_jobs");
    await database().query(
      "CREATE TABLE label_rebinding_marker AS SELECT id, updated_at FROM memory_items_all",
    );

    await database().query(
      await readFile(resolve("migrations/134_memory_author_label_rebinding.sql"), "utf8"),
    );

    expect((await stateOf(byName)).subject_label).toBe("Анна");
    expect((await stateOf(byUsername)).subject_telegram_id).toBe(ANNA_ID);
  });

  it("binds the owner of personal memory written by name to the owner", async () => {
    const { owner } = await createMemoryFamilyFixture("rebind");
    const personal = async (key: string, label: string) => {
      const source = await createMemoryCorrectionSource(owner, "personal");
      const item = await memoryRepository.create(owner, {
        ...createMemoryInput("personal", key, `Факт ${key}`),
        explicitSource: { ...source, subject: { kind: "none" } },
      });
      await database().query(
        "UPDATE memory_items_all SET subject_label = $2, profile_eligible = false WHERE id = $1",
        [item.id, label],
      );
      return item.id;
    };
    // The fixture's author is named «Автор исправления» on the message and the participant.
    const ownName = await personal("owner-name", "Автор исправления");
    const mother = await personal("mother", "Мама");
    await database().query("DELETE FROM memory_embedding_jobs");
    await database().query(
      "CREATE TABLE label_rebinding_marker AS SELECT id, updated_at FROM memory_items_all",
    );

    await database().query(
      await readFile(resolve("migrations/134_memory_author_label_rebinding.sql"), "utf8"),
    );

    expect(await stateOf(ownName)).toEqual({
      jobs: 1, profile_eligible: true, subject_label: null, subject_telegram_id: null,
      subject_user_id: owner.userId, updated_moved: false,
    });
    expect(await stateOf(mother)).toEqual({
      jobs: 0, profile_eligible: false, subject_label: "Мама", subject_telegram_id: null,
      subject_user_id: null, updated_moved: false,
    });
  });
});
