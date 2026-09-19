/**
 * Live authorization integration tests for model-facing memory reads.
 *
 * Constructs covered:
 * - Personal and family reads fail closed when a stale turn outlives family membership.
 * - Group reads require the current registration and family-private groups require membership.
 * - External groups retain their isolated group identity without granting family access.
 * - Deterministic thread sources independently revalidate stale authorization.
 * - Activation reauthorizes after every content/evidence read.
 * - List, retrieval/conflict closure, thread list/search/read, and brief activation share semantics.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "./database.js";
import {
  MEMORY_EMBEDDING_MODEL_VERSION,
} from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryListRepository } from "./memory-list-repository.js";
import { memoryRepository } from "./memory-repository.js";
import { memoryRetrievalRepository } from "./memory-retrieval-repository.js";
import { createMemoryThreadBriefRepository } from "./memory-thread-brief-repository.js";
import { loadMemoryThreadSources } from "./memory-thread-source-repository.js";
import { memoryThreadQueryRepository } from "./memory-thread-query-repository.js";
import {
  createBroadThread,
  createThreadRepositoryFixture,
  THREAD_TITLE_VECTOR,
} from "./memory-thread-repository.integration-fixtures.js";

const { QUERY_VECTOR, sourceEvidenceBoundary } = vi.hoisted(() => ({
  QUERY_VECTOR: [1, ...Array.from({ length: 383 }, () => 0)],
  sourceEvidenceBoundary: {
    beforeRead: null as null | (() => Promise<void>),
  },
}));

vi.mock("./memory-embedding-client.js", () => ({
  embedMemoryQuery: vi.fn(async () => QUERY_VECTOR),
}));

vi.mock("./memory-thread-source-evidence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./memory-thread-source-evidence.js")>();
  return {
    ...actual,
    loadMemoryThreadSourceEvidence: async (
      ...args: Parameters<typeof actual.loadMemoryThreadSourceEvidence>
    ) => {
      if (sourceEvidenceBoundary.beforeRead) await sourceEvidenceBoundary.beforeRead();
      return await actual.loadMemoryThreadSourceEvidence(...args);
    },
  };
});

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
if (enabled && (!databaseUrl || !new URL(databaseUrl).pathname.slice(1).endsWith("_test"))) {
  throw new Error(
    "AGENT_TEST_DATABASE_UNSAFE: Для live memory read integration-тестов нужна отдельная БД *_test",
  );
}
const describeWithDatabase = enabled ? describe : describe.skip;

interface ReadFixture {
  auth: MemoryAuthorization;
  claimId: string;
  familyId: string;
  groupId: string | null;
  threadRef: string;
  userId: string;
}

async function indexClaim(claimId: string): Promise<void> {
  // A deterministic vector makes retrieval authorization observable without a model provider.
  await database().query(
    "UPDATE memory_items SET embedding_status = 'indexed' WHERE id = $1",
    [claimId],
  );
  await database().query(
    `INSERT INTO memory_embedding_chunks
       (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
     SELECT id, 0, content, 0, char_length(content), $2::vector, $3
     FROM memory_items WHERE id = $1`,
    [claimId, `[${QUERY_VECTOR.join(",")}]`, MEMORY_EMBEDDING_MODEL_VERSION],
  );
}

async function createTrustedFixture(): Promise<ReadFixture> {
  const fixture = await createThreadRepositoryFixture();
  const page = await createBroadThread(fixture);
  const auth: MemoryAuthorization = { ...fixture.auth, scopes: ["personal", "family"] };
  const personal = await memoryRepository.create(auth, {
    confirmation: "user_confirmed",
    content: "Личный план ремонта",
    kind: "fact",
    operationKey: "live-read-personal",
    provenance: { sessionId: "stale-session", turnId: "stale-turn" },
    scope: "personal",
    sensitivity: "normal",
    source: "test:live-read",
  });
  const durableFamily = await memoryRepository.create(auth, {
    confirmation: "user_confirmed",
    content: "Семейный план ремонта вне группового журнала",
    kind: "fact",
    operationKey: "live-read-durable-family",
    provenance: { sessionId: "stale-session", turnId: "stale-turn" },
    scope: "family",
    sensitivity: "normal",
    source: "test:live-read",
  });
  await indexClaim(fixture.claimId);
  await indexClaim(personal.id);
  await indexClaim(durableFamily.id);
  return {
    auth,
    claimId: fixture.claimId,
    familyId: fixture.familyId,
    groupId: fixture.groupId,
    threadRef: page.items[0]!.threadRef,
    userId: fixture.userId,
  };
}

async function createExternalGroupFixture(suffix: string): Promise<ReadFixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Live group ${suffix}`],
  );
  const user = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, 'Group member') RETURNING id`,
    [`live-group-${suffix}`],
  );
  const familyId = family.rows[0]!.id;
  const userId = user.rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [familyId, userId],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, $3, 'external', 'addressed_only') RETURNING id`,
    [familyId, `-100-live-${suffix}`, `Live ${suffix}`],
  );
  const groupId = group.rows[0]!.id;
  const conversation = await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
    [groupId],
  );
  const participant = await database().query<{ id: string }>(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     VALUES ($1, $2, 'group', $3, $4, $5, 'Group member', now(), now()) RETURNING id`,
    [conversation.rows[0]!.id, familyId, groupId, `live-group-${suffix}`, userId],
  );
  const timeline = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, 1, 1, 'user', $3, $4, 'Group member', false, 'text',
             'Продолжаем групповой ремонт', now()) RETURNING id`,
    [conversation.rows[0]!.id, groupId, `telegram:live-group-${suffix}`, `live-group-${suffix}`],
  );
  const project = await database().query<{ id: string }>(
    `INSERT INTO memory_projects (family_id, group_id, scope, scope_partition_key, title)
     VALUES ($1, $2, 'group', $2, $3) RETURNING id`,
    [familyId, groupId, `Проект ${suffix}`],
  );
  const claim = await database().query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, group_id, author_telegram_user_id, scope, kind, content, source,
        confirmation, sensitivity, operation_key, embedding_status, provenance_state,
        origin_conversation_id, memory_project_id, save_approved, content_normalized,
        profile_eligible)
     VALUES ($1, $2, $3, 'group', 'episode', 'Групповой план ремонта', 'test:live-read',
             'user_confirmed', 'normal', $4, 'indexed', 'evidenced', $5, $6, true,
             'групповой план ремонта', false) RETURNING id`,
    [familyId, groupId, `live-group-${suffix}`, `live-group-claim-${suffix}`,
      conversation.rows[0]!.id, project.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO claim_evidence
       (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
        origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
        author_participant_id, author_user_id, author_label_snapshot, observed_at,
        evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
     VALUES ($1, $2, 'group', $3, 'primary', 'firsthand', $4, $5, $3, $6, $7,
             'Group member', now(), 'Продолжаем групповой ремонт', $8, 1, 1,
             '{"content":"Продолжаем групповой ремонт"}'::jsonb)`,
    [claim.rows[0]!.id, familyId, groupId, conversation.rows[0]!.id, `Live ${suffix}`,
      participant.rows[0]!.id, userId, timeline.rows[0]!.id],
  );
  await indexClaim(claim.rows[0]!.id);
  const thread = await database().query<{ id: string; thread_ref: string }>(
    `INSERT INTO memory_threads
       (family_id, scope, scope_partition_key, memory_project_id, title, purpose,
        title_embedding, title_embedding_model)
     VALUES ($1, 'group', $2, $3, 'Групповой ремонт', 'Хранить решения ремонта', $4::vector, $5)
     RETURNING id, thread_ref`,
    [familyId, groupId, project.rows[0]!.id, `[${QUERY_VECTOR.join(",")}]`,
      MEMORY_EMBEDDING_MODEL_VERSION],
  );
  await database().query(
    `INSERT INTO memory_thread_entries
       (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
     VALUES ($1, $2, 'group', $3, $4, 'goal', now())`,
    [thread.rows[0]!.id, familyId, groupId, claim.rows[0]!.id],
  );
  return {
    auth: {
      familyId,
      groupId,
      role: "external",
      scopes: ["group"],
      telegramActorId: `live-group-${suffix}`,
      telegramActorKind: "telegram_user",
      telegramUserId: `live-group-${suffix}`,
      userId: null,
    },
    claimId: claim.rows[0]!.id,
    familyId,
    groupId,
    threadRef: thread.rows[0]!.thread_ref,
    userId,
  };
}

async function expectReadable(fixture: ReadFixture): Promise<void> {
  const briefs = createMemoryThreadBriefRepository();
  expect((await memoryListRepository.list(fixture.auth, { limit: 20 })).items.length).toBeGreaterThan(0);
  expect((await memoryRetrievalRepository.search(fixture.auth, "ремонт", QUERY_VECTOR)).results.length)
    .toBeGreaterThan(0);
  expect((await memoryRetrievalRepository.searchWithConflictClosure(
    fixture.auth,
    "ремонт",
    QUERY_VECTOR,
  )).results.length).toBeGreaterThan(0);
  expect((await memoryThreadQueryRepository.list(fixture.auth, { limit: 20 })).items)
    .toHaveLength(1);
  expect(await memoryThreadQueryRepository.search(fixture.auth, "ремонт", 20)).toHaveLength(1);
  expect((await memoryThreadQueryRepository.read(fixture.auth, fixture.threadRef, { limit: 20 })).entries)
    .toHaveLength(1);
  expect((await briefs.activate({
    auth: fixture.auth,
    queryEmbedding: QUERY_VECTOR,
    retrievedClaimIds: [fixture.claimId],
    skillHints: [],
  })).threads).toHaveLength(1);
}

async function expectDenied(fixture: ReadFixture): Promise<void> {
  const briefs = createMemoryThreadBriefRepository();
  await expect(memoryListRepository.list(fixture.auth, { limit: 20 }))
    .resolves.toMatchObject({ items: [] });
  await expect(memoryRetrievalRepository.search(fixture.auth, "ремонт", QUERY_VECTOR))
    .resolves.toMatchObject({ results: [] });
  await expect(memoryRetrievalRepository.searchWithConflictClosure(
    fixture.auth,
    "ремонт",
    QUERY_VECTOR,
  )).resolves.toMatchObject({ conflicts: [], relatedClaimIds: [], results: [] });
  await expect(memoryThreadQueryRepository.list(fixture.auth, { limit: 20 }))
    .resolves.toMatchObject({ items: [] });
  await expect(memoryThreadQueryRepository.search(fixture.auth, "ремонт", 20)).resolves.toEqual([]);
  await expect(memoryThreadQueryRepository.read(fixture.auth, fixture.threadRef, { limit: 20 }))
    .rejects.toMatchObject({ code: "AGENT_MEMORY_THREAD_NOT_FOUND" });
  await expect(briefs.activate({
    auth: fixture.auth,
    queryEmbedding: QUERY_VECTOR,
    retrievedClaimIds: [fixture.claimId],
    skillHints: [],
  })).resolves.toEqual({ threads: [], totalCharacters: 0 });
}

describeWithDatabase("live memory read authorization", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("revokes personal and family reads immediately for stale turn authorization", async () => {
    const fixture = await createTrustedFixture();
    await expectReadable(fixture);

    // The Eve turn still carries old scopes, but the database membership is authoritative.
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [fixture.familyId, fixture.userId],
    );
    await expectDenied(fixture);
  });

  it("builds source-backed blocks without persisting a generated brief cache", async () => {
    const fixture = await createTrustedFixture();
    const briefs = createMemoryThreadBriefRepository();

    await expect(briefs.activate({
      auth: fixture.auth,
      queryEmbedding: QUERY_VECTOR,
      retrievedClaimIds: [fixture.claimId],
      skillHints: [],
    })).resolves.toMatchObject({
      threads: [expect.objectContaining({ blocks: expect.any(Array) })],
    });
    await expect(database().query(
      "SELECT 1 FROM memory_thread_briefs AS brief JOIN memory_threads AS thread ON thread.id = brief.thread_id WHERE thread.thread_ref = $1",
      [fixture.threadRef],
    )).resolves.toMatchObject({ rows: [] });
  });

  it("denies the thread source loader directly after membership revocation", async () => {
    const fixture = await createTrustedFixture();
    const thread = await database().query<{ id: string }>(
      "SELECT id FROM memory_threads WHERE thread_ref = $1",
      [fixture.threadRef],
    );
    const internal = thread.rows[0]!;
    const client = await database().connect();
    try {
      // Prove the defense-in-depth loader independently of activation candidate selection.
      await expect(loadMemoryThreadSources(client, internal.id, fixture.auth))
        .resolves.not.toHaveLength(0);
      await database().query(
        "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
        [fixture.familyId, fixture.userId],
      );
      await expect(loadMemoryThreadSources(client, internal.id, fixture.auth)).resolves.toEqual([]);
    } finally {
      client.release();
    }
  });

  it("withholds deterministic blocks when membership is revoked before the final evidence read", async () => {
    const fixture = await createTrustedFixture();
    const briefs = createMemoryThreadBriefRepository();
    const activation = {
      auth: fixture.auth,
      queryEmbedding: QUERY_VECTOR,
      retrievedClaimIds: [fixture.claimId],
      skillHints: [] as string[],
    };
    await expect(briefs.activate(activation)).resolves.toMatchObject({
      threads: [expect.objectContaining({ blocks: expect.any(Array) })],
    });
    let revoked = false;
    // Revoke at the final source-evidence boundary after deterministic source selection.
    sourceEvidenceBoundary.beforeRead = async () => {
      sourceEvidenceBoundary.beforeRead = null;
      await database().query(
        "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
        [fixture.familyId, fixture.userId],
      );
      revoked = true;
    };
    try {
      await expect(briefs.activate(activation)).resolves.toEqual({ threads: [], totalCharacters: 0 });
      expect(revoked).toBe(true);
    } finally {
      sourceEvidenceBoundary.beforeRead = null;
    }
  });

  it("requires live membership and registration for production family-private authorization", async () => {
    const fixture = await createTrustedFixture();
    fixture.auth = { ...fixture.auth, groupId: fixture.groupId, scopes: ["family"] };
    await expectReadable(fixture);

    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [fixture.familyId, fixture.userId],
    );
    await expectDenied(fixture);

    // A new valid membership cannot revive a stale turn after its exact group registration is gone.
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [fixture.familyId, fixture.userId],
    );
    await database().query("DELETE FROM telegram_groups WHERE id = $1", [fixture.groupId]);
    const survivingFamilyMemory = await database().query(
      `SELECT 1 FROM memory_items
       WHERE family_id = $1 AND operation_key = 'live-read-durable-family'`,
      [fixture.familyId],
    );
    expect(survivingFamilyMemory.rows).toHaveLength(1);
    await expectDenied(fixture);
  });

  it("keeps an external group isolated without membership and denies it after registration deletion", async () => {
    const fixture = await createExternalGroupFixture("external");
    await database().query(
      "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
      [fixture.familyId, fixture.userId],
    );
    await expectReadable(fixture);

    await database().query("DELETE FROM telegram_groups WHERE id = $1", [fixture.groupId]);
    await expectDenied(fixture);
  });
});
