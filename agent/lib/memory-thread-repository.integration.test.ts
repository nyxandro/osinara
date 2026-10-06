/**
 * End-to-end memory-thread repository integration tests.
 *
 * Constructs covered:
 * - First-conversation continuation creates one broad subjectless family project/thread and notice.
 * - Deterministic context reflects source edits immediately without a generated cache.
 * - Completion retains full history, links the parent, loads only the completion episode, and reactivates explicitly.
 * - All repository/tool-shaped results expose opaque refs without database or identity IDs.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { createMemoryThreadBriefRepository } from "./memory-thread-brief-repository.js";
import { memoryThreadLifecycleRepository } from "./memory-thread-lifecycle-repository.js";
import { memoryThreadNoticeRepository } from "./memory-thread-notice-repository.js";
import { memoryThreadQueryRepository } from "./memory-thread-query-repository.js";
import {
  createAdditionalProjectClaim,
  createBroadThread,
  createThreadRepositoryFixture as createFixture,
  THREAD_TITLE_VECTOR as TITLE_VECTOR,
} from "./memory-thread-repository.integration-fixtures.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("memory thread repositories", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("creates broad-first project state and uses live source context plus durable notices", async () => {
    const fixture = await createFixture();
    const page = await createBroadThread(fixture);

    expect(page.items).toEqual([expect.objectContaining({
      parentThreadRef: null,
      purpose: "Сохранять цели, решения и результаты ремонта",
      status: "active",
      threadRef: expect.stringMatching(/^thread_[0-9a-f]{32}$/u),
      title: "Ремонт",
    })]);
    const identity = await database().query<{ memory_project_id: string | null }>(
      "SELECT memory_project_id FROM memory_items WHERE id = $1",
      [fixture.claimId],
    );
    expect(identity.rows[0]!.memory_project_id).toEqual(expect.any(String));

    // A later main-agent claim attaches atomically without creating a duplicate thread.
    const additionalClaimId = await createAdditionalProjectClaim(fixture, page.items[0]!.threadRef);
    expect((await memoryThreadQueryRepository.list(fixture.auth, { limit: 20 })).items).toHaveLength(1);
    const attachedIdentity = await database().query<{ memory_project_id: string | null }>(
      "SELECT memory_project_id FROM memory_items WHERE id = $1",
      [additionalClaimId],
    );
    expect(attachedIdentity.rows[0]!.memory_project_id).toBe(identity.rows[0]!.memory_project_id);

    await expect(memoryThreadNoticeRepository.takePending(fixture.auth, fixture.conversationId))
      .resolves.toBeNull();

    const briefs = createMemoryThreadBriefRepository();
    const activation = {
      auth: fixture.auth,
      queryEmbedding: TITLE_VECTOR,
      retrievedClaimIds: [fixture.claimId],
      skillHints: [] as string[],
    };
    const first = await briefs.activate(activation);
    const second = await briefs.activate(activation);
    const fromTitle = await briefs.activate({ ...activation, retrievedClaimIds: [] });
    const fromSkill = await briefs.activate({
      ...activation,
      queryEmbedding: [-1, ...Array.from({ length: 383 }, () => 0)],
      retrievedClaimIds: [],
      skillHints: ["Ремонт"],
    });

    expect(first).toEqual(second);
    expect(fromTitle.threads[0]?.title).toBe("Ремонт");
    expect(fromSkill.threads[0]?.title).toBe("Ремонт");
    expect(JSON.stringify(first)).toContain("Ремонт будет продолжаться поэтапно");
    expect(JSON.stringify(first)).not.toMatch(/"(?:id|familyId|groupId|userId|scopePartitionKey)"/u);
    await database().query(
      "UPDATE memory_items SET content = 'Ремонт продолжается по новому плану' WHERE id = $1",
      [fixture.claimId],
    );
    const refreshed = await briefs.activate(activation);
    expect(JSON.stringify(refreshed)).toContain("Ремонт продолжается по новому плану");
  });

  it("retains completed subthread history, links its parent, and requires explicit reactivation", async () => {
    const fixture = await createFixture();
    const page = await createBroadThread(fixture);
    const rootRef = page.items[0]!.threadRef;
    const internal = await database().query<{
      id: string;
      memory_project_id: string;
    }>(
      "SELECT id, memory_project_id FROM memory_threads WHERE thread_ref = $1",
      [rootRef],
    );
    const child = await database().query<{ thread_ref: string }>(
      `INSERT INTO memory_threads
         (family_id, scope, scope_partition_key, memory_project_id, parent_thread_id, title, purpose)
       VALUES ($1, 'family', $1, $2, $3, 'Кухня', 'Завершить ремонт кухни') RETURNING thread_ref`,
      [fixture.familyId, internal.rows[0]!.memory_project_id, internal.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO memory_thread_entries
         (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
       SELECT id, family_id, scope, scope_partition_key, $2, 'goal', now()
       FROM memory_threads WHERE thread_ref = $1`,
      [child.rows[0]!.thread_ref, fixture.claimId],
    );
    const before = await memoryThreadQueryRepository.read(
      fixture.auth,
      child.rows[0]!.thread_ref,
      { limit: 20 },
    );
      const completionMessage = await database().query<{ id: string }>(
        `INSERT INTO telegram_group_messages
          (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
           telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
        VALUES ($1, $2, 702, 2, 'user', 'telegram:thread-owner', 'thread-owner', 'Owner', false,
                'text', 'Ремонт кухни завершён, всё работает', now()) RETURNING id`,
        [fixture.conversationId, fixture.groupId],
    );
    await memoryThreadLifecycleRepository.complete(fixture.auth, {
      authority: { kind: "current_user_statement" },
      operationKey: "complete-kitchen",
      sourceEntryRefs: [before.entries[0]!.entryRef],
      threadRef: child.rows[0]!.thread_ref,
      turn: { conversationId: fixture.conversationId, timelineEntryId: completionMessage.rows[0]!.id },
    });

    const completed = await memoryThreadQueryRepository.read(
      fixture.auth,
      child.rows[0]!.thread_ref,
      { limit: 20 },
    );
    expect(completed.thread.status).toBe("completed");
    expect(completed.entries).toHaveLength(2);
    expect(completed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "Ремонт кухни завершён, всё работает", sourceType: "confirmed_outcome" }),
      expect.objectContaining({
        content: "Ремонт будет продолжаться поэтапно",
        sourceEvidence: expect.objectContaining({ authorLabel: "Анна", kind: "reported" }),
        sourceType: "claim",
      }),
    ]));
    const parentCompletion = await database().query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM memory_thread_entries AS entry
       JOIN memory_threads AS parent ON parent.id = entry.thread_id
       WHERE parent.thread_ref = $1 AND entry.role = 'episode' AND entry.source_outcome_id IS NOT NULL`,
      [rootRef],
    );
    expect(parentCompletion.rows).toEqual([{ count: 1 }]);

    const briefRepository = createMemoryThreadBriefRepository();
    const context = await briefRepository.activate({
      auth: fixture.auth,
      queryEmbedding: TITLE_VECTOR,
      retrievedClaimIds: [fixture.claimId],
      skillHints: [],
    });
    const completedContext = context.threads.find((thread) => thread.threadRef === child.rows[0]!.thread_ref);
    const serializedContext = JSON.stringify(context);
    expect(serializedContext.match(/Ремонт кухни завершён, всё работает/gu)).toHaveLength(1);
    if (completedContext) {
      expect(completedContext).toMatchObject({
        completionEpisode: { content: "Ремонт кухни завершён, всё работает" },
        status: "completed",
      });
      expect(completedContext).not.toHaveProperty("blocks");
    }

    const reactivationMessage = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
          (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
           telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
        VALUES ($1, $2, 703, 3, 'user', 'telegram:thread-owner', 'thread-owner', 'Owner', false,
                'text', 'Явно возобновляем старую нить ремонта кухни', now()) RETURNING id`,
      [fixture.conversationId, fixture.groupId],
    );
    await expect(memoryThreadLifecycleRepository.reactivate(fixture.auth, {
      operationKey: "reactivate-kitchen",
      threadRef: child.rows[0]!.thread_ref,
      turn: { conversationId: fixture.conversationId, timelineEntryId: reactivationMessage.rows[0]!.id },
    })).resolves.toEqual({ status: "active", threadRef: child.rows[0]!.thread_ref });
    expect((await memoryThreadQueryRepository.read(
      fixture.auth,
      child.rows[0]!.thread_ref,
      { limit: 20 },
    )).thread.status).toBe("active");
  });

  it("rejects root completion and a current statement that does not explicitly prove completion", async () => {
    const fixture = await createFixture();
    const page = await createBroadThread(fixture);
    const rootRef = page.items[0]!.threadRef;
    const root = await memoryThreadQueryRepository.read(fixture.auth, rootRef, { limit: 20 });
    const continuingMessage = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 706, 4, 'user', 'telegram:thread-owner', 'thread-owner', 'Owner', false,
               'text', 'Ремонт кухни не завершён, продолжаем по плану', now()) RETURNING id`,
      [fixture.conversationId, fixture.groupId],
    );

    await expect(memoryThreadLifecycleRepository.complete(fixture.auth, {
      authority: { kind: "current_user_statement" },
      operationKey: "complete-root-forbidden",
      sourceEntryRefs: [root.entries[0]!.entryRef],
      threadRef: rootRef,
      turn: { conversationId: fixture.conversationId, timelineEntryId: continuingMessage.rows[0]!.id },
    })).rejects.toThrowError(/AGENT_MEMORY_THREAD_ROOT_COMPLETION_FORBIDDEN/u);

    const internal = await database().query<{ id: string; memory_project_id: string }>(
      "SELECT id, memory_project_id FROM memory_threads WHERE thread_ref = $1",
      [rootRef],
    );
    const child = await database().query<{ thread_ref: string }>(
      `INSERT INTO memory_threads
         (family_id, scope, scope_partition_key, memory_project_id, parent_thread_id, title, purpose)
       VALUES ($1, 'family', $1, $2, $3, 'Кухня', 'Завершить ремонт кухни') RETURNING thread_ref`,
      [fixture.familyId, internal.rows[0]!.memory_project_id, internal.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO memory_thread_entries
         (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
       SELECT id, family_id, scope, scope_partition_key, $2, 'goal', now()
       FROM memory_threads WHERE thread_ref = $1`,
      [child.rows[0]!.thread_ref, fixture.claimId],
    );
    const childHistory = await memoryThreadQueryRepository.read(
      fixture.auth,
      child.rows[0]!.thread_ref,
      { limit: 20 },
    );

    await expect(memoryThreadLifecycleRepository.complete(fixture.auth, {
      authority: { kind: "current_user_statement" },
      operationKey: "complete-without-semantic-proof",
      sourceEntryRefs: [childHistory.entries[0]!.entryRef],
      threadRef: child.rows[0]!.thread_ref,
      turn: { conversationId: fixture.conversationId, timelineEntryId: continuingMessage.rows[0]!.id },
    })).rejects.toThrowError(/AGENT_MEMORY_THREAD_COMPLETION_NOT_PROVEN/u);
  });

  it("does not activate an external origin thread from an inward personal claim projection", async () => {
    const fixture = await createFixture();
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100-thread-external', 'External', 'external', 'addressed_only') RETURNING id`,
      [fixture.familyId],
    );
    const conversation = await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
      [group.rows[0]!.id],
    );
    const participant = await database().query<{ id: string }>(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, 'group', $3, 'thread-owner', $4, 'Owner', now(), now()) RETURNING id`,
      [conversation.rows[0]!.id, fixture.familyId, group.rows[0]!.id, fixture.userId],
    );
    const timeline = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (group_id, conversation_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 705, 1, 'user', 'telegram:thread-owner', 'thread-owner', 'Owner',
               false, 'text', 'Внешняя группа обсуждает отдельный проект', now()) RETURNING id`,
      [group.rows[0]!.id, conversation.rows[0]!.id],
    );
    const project = await database().query<{ id: string }>(
      `INSERT INTO memory_projects (family_id, group_id, scope, scope_partition_key, title)
       VALUES ($1, $2, 'group', $2, 'Внешний проект') RETURNING id`,
      [fixture.familyId, group.rows[0]!.id],
    );
    const claim = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, group_id, author_telegram_user_id, scope, kind, content, source,
          confirmation, sensitivity, operation_key, provenance_state, origin_conversation_id,
          memory_project_id, save_approved, content_normalized, profile_eligible)
       VALUES ($1, $2, 'thread-owner', 'group', 'fact', 'Только внешний проект', 'extraction',
               'model_high', 'normal', 'external-thread-claim', 'evidenced', $3, $4, true,
               'только внешний проект', false) RETURNING id`,
      [fixture.familyId, group.rows[0]!.id, conversation.rows[0]!.id, project.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO claim_evidence
         (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
          origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
          author_participant_id, author_user_id, author_label_snapshot, observed_at,
          evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
       VALUES ($1, $2, 'group', $3, 'primary', 'firsthand', $4, 'External', $3, $5, $6,
               'Owner', now(), 'Внешняя группа обсуждает отдельный проект', $7, 1, 705,
               '{"content":"Внешняя группа обсуждает отдельный проект"}'::jsonb)`,
      [claim.rows[0]!.id, fixture.familyId, group.rows[0]!.id, conversation.rows[0]!.id,
        participant.rows[0]!.id, fixture.userId, timeline.rows[0]!.id],
    );
    const thread = await database().query<{ id: string }>(
      `INSERT INTO memory_threads
         (family_id, scope, scope_partition_key, memory_project_id, title, purpose)
       VALUES ($1, 'group', $2, $3, 'Внешний проект', 'Изолированный контекст') RETURNING id`,
      [fixture.familyId, group.rows[0]!.id, project.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO memory_thread_entries
         (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
       VALUES ($1, $2, 'group', $3, $4, 'goal', now())`,
      [thread.rows[0]!.id, fixture.familyId, group.rows[0]!.id, claim.rows[0]!.id],
    );

    const briefs = createMemoryThreadBriefRepository();
    await expect(briefs.activate({
      auth: { ...fixture.auth, scopes: ["personal", "family"] },
      queryEmbedding: TITLE_VECTOR,
      retrievedClaimIds: [claim.rows[0]!.id],
      skillHints: [],
    })).resolves.toEqual({ threads: [], totalCharacters: 0 });
  });
});
