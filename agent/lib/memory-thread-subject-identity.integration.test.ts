/**
 * Explicit subject identity integration tests for memory threads.
 *
 * Constructs covered:
 * - A second author cannot silently inherit another person's subject-thread identity.
 * - A current-turn verified subject ref records the second author's statement as reported evidence.
 * - Different authors can append subjectless claims to one shared project-thread.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-embedding-client.js")>(),
  embedMemoryPassages: vi.fn(async () => [
    [1, ...Array.from({ length: 383 }, () => 0)],
  ]),
}));

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("memory thread subject identity", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });
  afterAll(closeDatabase);

  it("requires explicit cross-author identity while allowing shared project continuation", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const subjectThread = await memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Анна начала готовиться к марафону",
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "current_author" },
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "episode",
      operationKey: "subject-thread-create",
      provenance: { sessionId: "subject-session", turnId: "subject-create-turn" },
      scope: "family",
      sensitivity: "normal",
      source: "turn:subject-session:subject-create-turn",
      thread: {
        action: "create",
        purpose: "Сохранять тренировки и результаты Анны",
        role: "goal",
        title: "Марафон Анны",
      },
    });

    const reporter = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('memory-reporter', 'Борис') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')",
      [fixture.familyId, reporter.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, 'family', $2, 'memory-reporter', $3, 'Борис', now(), now())`,
      [fixture.conversationId, fixture.familyId, reporter.rows[0]!.id],
    );
    const reportSource = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 903, 2, 'user', 'telegram:memory-reporter', 'memory-reporter',
               'Борис', false, 'text', 'Анна пробежала первые десять километров', now()) RETURNING id`,
      [fixture.conversationId, fixture.groupId],
    );
    const reporterAuth: MemoryAuthorization = {
      familyId: fixture.familyId,
      groupId: fixture.groupId,
      role: "member",
      scopes: ["family"],
      telegramActorId: "memory-reporter",
      telegramActorKind: "telegram_user",
      telegramUserId: "memory-reporter",
      userId: reporter.rows[0]!.id,
    };

    await expect(memoryRepository.create(reporterAuth, {
      confirmation: "model_high",
      content: "Анна пробежала первые десять километров",
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "none" },
        timelineEntryId: reportSource.rows[0]!.id,
      },
      kind: "episode",
      operationKey: "implicit-cross-author-attach",
      provenance: { sessionId: "report-session", turnId: "report-turn" },
      scope: "family",
      sensitivity: "normal",
      source: "turn:report-session:report-turn",
      thread: { action: "attach", role: "outcome", threadRef: subjectThread.thread!.threadRef },
    })).rejects.toMatchObject({ code: "AGENT_MEMORY_THREAD_INPUT_INVALID" });

    const subject = await database().query<{ id: string; subject_ref: string }>(
      `SELECT id, subject_ref FROM profile_subjects
        WHERE conversation_id = $1 AND subject_user_id = $2`,
      [fixture.conversationId, fixture.userId],
    );
    const view = await database().query<{ id: string }>(
      `INSERT INTO profile_views
         (family_id, viewer_conversation_id, viewer_user_id, subject_count,
          claim_count, total_characters, agent_session_id, agent_turn_id)
       VALUES ($1, $2, $3, 1, 0, 0, 'report-session', 'report-turn') RETURNING id`,
      [fixture.familyId, fixture.conversationId, reporter.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO profile_view_subjects
         (profile_view_id, ordinal, profile_subject_id, subject_ref_snapshot,
          subject_label_snapshot, priority_reason, total_characters)
       VALUES ($1, 0, $2, $3, 'Анна', 'explicit_mention', 0)`,
      [view.rows[0]!.id, subject.rows[0]!.id, subject.rows[0]!.subject_ref],
    );
    const reported = await memoryRepository.create(reporterAuth, {
      confirmation: "model_high",
      content: "Анна пробежала первые десять километров",
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "verified_ref", subjectRef: subject.rows[0]!.subject_ref },
        timelineEntryId: reportSource.rows[0]!.id,
      },
      kind: "episode",
      operationKey: "explicit-cross-author-attach",
      provenance: { sessionId: "report-session", turnId: "report-turn" },
      scope: "family",
      sensitivity: "normal",
      source: "turn:report-session:report-turn",
      thread: { action: "attach", role: "outcome", threadRef: subjectThread.thread!.threadRef },
    });
    await expect(database().query(
      `SELECT item.subject_user_id, evidence.evidence_kind
         FROM memory_items AS item
         JOIN claim_evidence AS evidence ON evidence.claim_id = item.id
        WHERE item.id = $1`,
      [reported.id],
    )).resolves.toMatchObject({
      rows: [{ evidence_kind: "reported", subject_user_id: fixture.userId }],
    });

    const projectSource = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 904, 3, 'user', 'telegram:memory-reporter', 'memory-reporter',
               'Борис', false, 'text', 'Общий список новинок пополнился новым релизом', now()) RETURNING id`,
      [fixture.conversationId, fixture.groupId],
    );
    const project = await memoryRepository.create(reporterAuth, {
      confirmation: "model_high",
      content: "Общий список новинок пополнился новым релизом",
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "none" },
        timelineEntryId: projectSource.rows[0]!.id,
      },
      kind: "fact",
      operationKey: "shared-project-create",
      provenance: { sessionId: "report-session", turnId: "project-turn" },
      scope: "family",
      sensitivity: "normal",
      source: "turn:report-session:project-turn",
      thread: {
        action: "create",
        identity: "project",
        purpose: "Собирать общие долгосрочные новинки участников",
        role: "episode",
        title: "Новинки",
      },
    });
    expect(project.thread).toMatchObject({ action: "created" });
    const authorProjectSource = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 905, 4, 'user', 'telegram:agent-memory-author', 'agent-memory-author',
               'Анна', false, 'text', 'Вышла ещё одна полезная библиотека', now()) RETURNING id`,
      [fixture.conversationId, fixture.groupId],
    );
    await memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Вышла ещё одна полезная библиотека",
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "none" },
        timelineEntryId: authorProjectSource.rows[0]!.id,
      },
      kind: "fact",
      operationKey: "shared-project-attach-second-author",
      provenance: { sessionId: "subject-session", turnId: "project-author-turn" },
      scope: "family",
      sensitivity: "normal",
      source: "turn:subject-session:project-author-turn",
      thread: { action: "attach", role: "episode", threadRef: project.thread!.threadRef },
    });
    await expect(database().query(
      `SELECT count(DISTINCT item.author_user_id)::integer AS authors,
              count(*)::integer AS entries
         FROM memory_thread_entries AS entry
         JOIN memory_items AS item ON item.id = entry.source_claim_id
         JOIN memory_threads AS thread ON thread.id = entry.thread_id
        WHERE thread.thread_ref = $1`,
      [project.thread!.threadRef],
    )).resolves.toMatchObject({ rows: [{ authors: 2, entries: 2 }] });
  });
});
