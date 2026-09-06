/**
 * PostgreSQL long-term memory integration tests.
 *
 * Constructs covered:
 * - Scope filters prevent cross-user, cross-group, and cross-family disclosure.
 * - Family and group mutations enforce author-or-owner access against current database roles.
 * - Opaque refs resolve only inside the already-authorized family, personal, and group scope.
 * - Create/edit operations are replay-safe; edits preserve an explicit correction version chain.
 * - Physical deletion removes the searchable record.
 * - Pagination cursors contain stable opaque refs rather than database UUIDs.
 * - Create and immediate-undo operations are replay-safe and provenance-bound.
 * - Scope quotas are enforced inside the write transaction.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { MemoryAuthorization } from "./memory-context.js";
import { closeDatabase, database } from "./database.js";
import { MEMORY_SCOPE_QUOTAS } from "./memory-config.js";
import { memoryOperationHash } from "./memory-record.js";
import { memoryRepository } from "./memory-repository.js";
import {
  createMemoryCorrectionSource as correctionSource,
  createMemoryFamilyFixture as createFamily,
  createMemoryInput as createInput,
  INVALID_SOURCE,
} from "./memory-repository.integration-fixtures.js";
const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;
if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error(
      "AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL",
    );
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
describeWithDatabase("memoryRepository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_embedding_jobs, behavior_preferences, memory_items_all, audit_events,
         telegram_groups, family_memberships, users, families CASCADE`,
    );
  });
  afterAll(async () => {
    await closeDatabase();
  });
  it("isolates personal records by user and every record by family", async () => {
    const first = await createFamily("first");
    const second = await createFamily("second");
    await memoryRepository.create(first.owner, createInput("personal", "first-owner"));
    await memoryRepository.create(first.member, createInput("personal", "first-member"));
    await memoryRepository.create(second.owner, createInput("personal", "second-owner"));
    const visible = await memoryRepository.list(first.owner, { limit: 20 });
    expect(visible.items).toHaveLength(1);
    expect(visible.items[0]?.author).toEqual({
      status: "current_member",
      telegramUserId: null,
      userId: first.owner.userId,
    });
    await expect(memoryRepository.list(first.owner, { cursor: "invalid", limit: 20 }))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_CURSOR_INVALID" });
  });
  it("keeps the event date and the slot when a record is corrected", async () => {
    const family = await createFamily("family-correction-fields");
    const episode = await memoryRepository.create(family.member, {
      ...createInput("family", "episode-create", "Анна ездила в Питер на конференцию"),
      kind: "episode",
      occurredAt: "2026-09-08",
    });
    const profile = await memoryRepository.create(family.member, {
      ...createInput("family", "profile-create", "Анна работает логистом"),
      attribute: "работа",
      kind: "profile",
    });
    const source = await correctionSource(family.owner, "family");

    const correctedEpisode = await memoryRepository.updateByRef(family.owner, {
      content: "Анна ездила в Питер на конференцию по логистике",
      memoryRef: episode.memoryRef,
      operationKey: "episode-correct",
      source,
    });
    const correctedProfile = await memoryRepository.updateByRef(family.owner, {
      content: "Анна работает старшим логистом",
      memoryRef: profile.memoryRef,
      operationKey: "profile-correct",
      source,
    });

    // The corrected event stays in its date window; the corrected profile claim stays in its slot.
    expect(correctedEpisode.occurredAt).toBe("2026-09-08T00:00:00.000Z");
    await expect(database().query(
      "SELECT attribute, occurred_at FROM memory_items WHERE id = $1",
      [correctedProfile.id],
    )).resolves.toMatchObject({ rows: [{ attribute: "работа", occurred_at: null }] });
  });

  it("keeps episodes with the same words on different dates apart", async () => {
    const family = await createFamily("family-episode-dates");
    const trip = (operationKey: string, occurredAt: string) => memoryRepository.create(family.member, {
      ...createInput("family", operationKey, "Анна ездила в Питер"),
      kind: "episode",
      occurredAt,
    });

    const september = await trip("trip-september", "2026-09-08");
    const october = await trip("trip-october", "2026-10-01");
    const septemberAgain = await trip("trip-september-again", "2026-09-08");
    // The same words as a fact are a different record from the episode.
    const fact = await memoryRepository.create(family.member, {
      ...createInput("family", "trip-fact", "Анна ездила в Питер"),
      kind: "fact",
    });

    expect(october.id).not.toBe(september.id);
    expect(septemberAgain.id).toBe(september.id);
    expect(fact.id).not.toBe(september.id);
    await expect(database().query(
      "SELECT reinforcement_count FROM memory_items WHERE id = $1",
      [september.id],
    )).resolves.toMatchObject({ rows: [{ reinforcement_count: 1 }] });
  });

  it("allows only the family author or current owner to update and delete a shared record", async () => {
    const family = await createFamily("family-rights");
    const record = await memoryRepository.create(
      family.member,
      createInput("family", "family-create", "Отпуск запланирован на август"),
    );
    const source = await correctionSource(family.owner, "family");
    const corrected = await memoryRepository.updateByRef(family.owner, {
      content: "Отпуск запланирован на сентябрь",
      memoryRef: record.memoryRef,
      operationKey: "family-owner-update",
      source,
    });
    expect(corrected).toMatchObject({ content: "Отпуск запланирован на сентябрь" });
    expect(corrected.memoryRef).not.toBe(record.memoryRef);
    const versions = await database().query<{
      claim_status: string;
      content: string;
      memory_ref: string;
      relation_type: string | null;
    }>(
      `SELECT item.content, item.claim_status::text, ref.memory_ref,
              relation.relation_type::text
       FROM memory_items AS item
       JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
       LEFT JOIN claim_relations AS relation ON relation.source_claim_id = item.id
       WHERE item.id IN ($1, $2) ORDER BY item.created_at, item.id`,
      [record.id, corrected.id],
    );
    expect(versions.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        claim_status: "superseded", content: "Отпуск запланирован на август",
        memory_ref: record.memoryRef,
        relation_type: "correction",
      }),
      expect.objectContaining({
        claim_status: "active", content: "Отпуск запланирован на сентябрь",
        memory_ref: corrected.memoryRef,
      }),
    ]));
    await expect(memoryRepository.updateByRef(family.owner, {
      content: "Отпуск запланирован на сентябрь",
      memoryRef: record.memoryRef,
      operationKey: "family-owner-update",
      source,
    })).resolves.toEqual(corrected);
    const otherFamily = await createFamily("other-family");
    await expect(
      memoryRepository.updateByRef(otherFamily.owner, {
        content: "Чужое изменение",
        memoryRef: record.memoryRef,
        operationKey: "cross-family-update",
        source: INVALID_SOURCE,
      }),
    ).rejects.toThrowError(/AGENT_MEMORY_NOT_FOUND/);
    await database().query(
      "UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2",
      [family.familyId, family.owner.userId],
    );
    await expect(
      memoryRepository.deleteByRef(family.owner, record.memoryRef, "revoked-owner-delete"),
    ).rejects.toThrowError(/AGENT_MEMORY_MUTATION_DENIED/);
  });
  it("retains a family record without external identity after its author is deleted", async () => {
    const family = await createFamily("former-author");
    const record = await memoryRepository.create(
      family.member,
      createInput("family", "former-create", "Семейное правило остаётся общим"),
    );
    await database().query("DELETE FROM users WHERE id = $1", [family.member.userId]);
    const visible = await memoryRepository.list(family.owner, { limit: 20, scope: "family" });
    expect(visible.items).toHaveLength(1);
    expect(visible.items[0]).toMatchObject({
      id: record.id,
      author: {
        status: "former_member", telegramUserId: null, userId: null,
      },
    });
  });
  it("lets a Telegram group author manage their record and rejects another participant", async () => {
    const family = await createFamily("group-rights");
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100101', 'Рабочая группа', 'external', 'addressed_only')
       RETURNING id`,
      [family.familyId],
    );
    const author: MemoryAuthorization = {
      familyId: family.familyId, groupId: group.rows[0]!.id, role: "external",
      scopes: ["group"], telegramActorId: "telegram-author", telegramActorKind: "telegram_user",
      telegramUserId: "telegram-author", userId: null,
    };
    const stranger = {
      ...author,
      telegramActorId: "telegram-stranger",
      telegramUserId: "telegram-stranger",
    };
    const record = await memoryRepository.create(author, createInput("group", "group-create"));
    await expect(
      memoryRepository.updateByRef(stranger, {
        content: "Чужое изменение",
        memoryRef: record.memoryRef,
        operationKey: "group-stranger-update",
        source: INVALID_SOURCE,
      }),
    ).rejects.toThrowError(/AGENT_MEMORY_MUTATION_DENIED/);
    await expect(
      memoryRepository.deleteByRef(author, record.memoryRef, "group-author-delete"),
    ).resolves.toEqual({ deleted: true });
  });
  it("returns the original record for an identical Eve replay and rejects changed input", async () => {
    const family = await createFamily("replay");
    const input = createInput("personal", "same-call");
    const first = await memoryRepository.create(family.owner, input);
    await expect(memoryRepository.create(family.owner, input)).resolves.toEqual(first);
    await expect(
      memoryRepository.create(family.owner, { ...input, content: "Подменённое значение" }),
    ).rejects.toThrowError(/AGENT_MEMORY_REPLAY_MISMATCH/);
    await expect(memoryRepository.create(family.owner, {
      ...input,
      provenance: { sessionId: "replayed-from-another-session", turnId: "other-turn" },
    })).rejects.toThrowError(/AGENT_MEMORY_REPLAY_MISMATCH/);
    expect(first.memoryRef).toMatch(/^mem_[0-9a-f]{32}$/u);
  });
  it("reinforces an exact explicit remember without creating a second claim", async () => {
    const family = await createFamily("explicit-exact");
    const first = await memoryRepository.create(
      family.owner,
      createInput("personal", "explicit-exact-first", "Анна любит улун"),
    );
    const second = await memoryRepository.create(
      family.owner,
      createInput("personal", "explicit-exact-second", "  анна   любит улун  "),
    );
    expect(second.id).toBe(first.id);
    const persisted = await database().query<{
      count: number;
      last_reinforced_at: Date | null;
      reinforcement_count: number;
    }>(
      `SELECT count(*) OVER ()::integer AS count, reinforcement_count, last_reinforced_at
       FROM memory_items WHERE family_id = $1 AND owner_user_id = $2`,
      [family.familyId, family.owner.userId],
    );
    expect(persisted.rows).toEqual([expect.objectContaining({
      count: 1,
      last_reinforced_at: expect.any(Date),
      reinforcement_count: 1,
    })]);
  });
  it("records a system-authored exact reinforcement without the sponsor as audit actor", async () => {
    const family = await createFamily("system-exact");
    await memoryRepository.create(
      family.owner,
      createInput("personal", "system-exact-first", "Анна любит улун"),
    );
    await memoryRepository.create(family.owner, {
      ...createInput("personal", "system-exact-second", "Анна любит улун"),
      systemActor: true,
    });

    await expect(database().query(
      `SELECT audit.actor_user_id, operation.actor_user_id AS operation_actor_user_id,
              operation.actor_telegram_user_id, operation.eve_session_id, operation.eve_turn_id
         FROM audit_events AS audit
         JOIN memory_mutation_operations AS operation ON operation.memory_item_id = audit.subject_id
          AND operation.operation_key = 'system-exact-second'
        WHERE audit.family_id = $1 AND audit.event_type = 'memory.reinforced'`,
      [family.familyId],
    )).resolves.toMatchObject({ rows: [{
      actor_telegram_user_id: null,
      actor_user_id: null,
      eve_session_id: "session-current",
      eve_turn_id: "turn-current",
      operation_actor_user_id: null,
    }] });
  });
  it("rejects a system-authored memory mutation without Eve provenance", async () => {
    const family = await createFamily("system-no-provenance");

    await expect(memoryRepository.create(family.owner, {
      ...createInput("personal", "system-no-provenance"),
      provenance: undefined,
      systemActor: true,
    })).rejects.toThrowError(/AGENT_MEMORY_SYSTEM_PROVENANCE_REQUIRED/u);
  });
  it("resolves opaque refs only inside the authorized scope", async () => {
    const family = await createFamily("ref-scope");
    const personal = await memoryRepository.create(
      family.owner,
      createInput("personal", "ref-personal"),
    );
    const shared = await memoryRepository.create(
      family.owner,
      createInput("family", "ref-family"),
    );
    const otherFamily = await createFamily("ref-other-family");
    await expect(memoryRepository.updateByRef(family.member, {
      content: "Чужая личная запись",
      memoryRef: personal.memoryRef,
      operationKey: "ref-cross-user",
      source: INVALID_SOURCE,
    })).rejects.toThrowError(/AGENT_MEMORY_NOT_FOUND/);

    const replayInput = {
      content: "Личная запись после исправления",
      memoryRef: personal.memoryRef,
      operationKey: "ref-owner-update",
      source: await correctionSource(family.owner, "personal"),
    };
    await expect(memoryRepository.updateByRef(family.owner, replayInput)).resolves.toMatchObject({
      content: replayInput.content,
    });
    await expect(
      memoryRepository.updateByRef(family.member, replayInput),
    ).rejects.toThrowError(/AGENT_MEMORY_NOT_FOUND/);
    await expect(memoryRepository.updateByRef(otherFamily.owner, {
      content: "Чужая семейная запись",
      memoryRef: shared.memoryRef,
      operationKey: "ref-cross-family",
      source: INVALID_SOURCE,
    })).rejects.toThrowError(/AGENT_MEMORY_NOT_FOUND/);
    const firstGroup = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100201', 'Первая группа', 'external', 'addressed_only') RETURNING id`,
      [family.familyId],
    );
    const secondGroup = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100202', 'Вторая группа', 'external', 'addressed_only') RETURNING id`,
      [family.familyId],
    );
    const groupAuthor: MemoryAuthorization = {
      familyId: family.familyId,
      groupId: firstGroup.rows[0]!.id,
      role: "external",
      scopes: ["group"],
      telegramActorId: "ref-group-author",
      telegramActorKind: "telegram_user",
      telegramUserId: "ref-group-author",
      userId: null,
    };
    const otherGroup = { ...groupAuthor, groupId: secondGroup.rows[0]!.id };
    const groupMemory = await memoryRepository.create(
      groupAuthor,
      createInput("group", "ref-group"),
    );
    await expect(
      memoryRepository.deleteByRef(otherGroup, groupMemory.memoryRef, "ref-cross-group"),
    ).rejects.toThrowError(/AGENT_MEMORY_NOT_FOUND/);
  });
  it("paginates with an opaque cursor that contains no database UUID", async () => {
    const family = await createFamily("cursor");
    const first = await memoryRepository.create(
      family.owner,
      createInput("personal", "cursor-first", "Альфа"),
    );
    await memoryRepository.create(
      family.owner,
      createInput("personal", "cursor-second", "Омега"),
    );
    const page = await memoryRepository.list(family.owner, { limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor).not.toContain(first.id);
    expect(page.nextCursor).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-/iu);
    await expect(memoryRepository.list(family.owner, {
      cursor: page.nextCursor!,
      limit: 1,
    })).resolves.toMatchObject({ items: [{ memoryRef: expect.stringMatching(/^mem_/u) }] });
    await expect(memoryRepository.list(family.owner, {
      cursor: page.nextCursor!, limit: 1, scope: "family",
    })).rejects.toMatchObject({ code: "AGENT_MEMORY_CURSOR_INVALID" });
  });

  it("bounds immediate undo by unchanged create provenance and replays it safely", async () => {
    const family = await createFamily("undo-provenance");
    const provenance = { sessionId: "session-undo", turnId: "turn-undo" };
    const record = await memoryRepository.create(family.owner,
      createInput("personal", "undo-create", "Временная запись", provenance));
    await expect(memoryRepository.canUndoCreate(family.owner, record.memoryRef, provenance))
      .resolves.toBe(true);
    await expect(memoryRepository.canUndoCreate(family.owner, record.memoryRef,
      { sessionId: "other-session", turnId: provenance.turnId })).resolves.toBe(false);
    await expect(memoryRepository.canUndoCreate(family.member, record.memoryRef, provenance))
      .resolves.toBe(false);
    // A versioned correction records a mutation against the source claim and revokes immediate undo.
    const updated = await memoryRepository.create(family.owner,
      createInput("personal", "updated-create", "Любимый цвет пользователя синий", provenance));
    await memoryRepository.updateByRef(family.owner, {
      content: "Изменённая запись", memoryRef: updated.memoryRef,
      operationKey: "intervening-update", source: await correctionSource(family.owner, "personal"),
    });
    await expect(memoryRepository.canUndoCreate(family.owner, updated.memoryRef, provenance))
      .resolves.toBe(false);
    await expect(memoryRepository.undoCreate(family.owner, updated.memoryRef,
      { operationKey: "denied-undo", ...provenance }))
      .rejects.toThrowError(/AGENT_MEMORY_UNDO_DENIED/u);
    const undo = { operationKey: "undo-call", ...provenance };
    await expect(memoryRepository.undoCreate(family.owner, record.memoryRef, undo))
      .resolves.toEqual({ deleted: true });
    await expect(memoryRepository.undoCreate(family.owner, record.memoryRef, undo))
      .resolves.toEqual({ deleted: true });
    await expect(memoryRepository.undoCreate(family.owner, record.memoryRef,
      { ...undo, sessionId: "replayed-from-another-session" }))
      .rejects.toThrowError(/AGENT_MEMORY_REPLAY_MISMATCH/u);
    const audit = await database().query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE subject_id = $1 AND event_type = 'memory.deleted'",
      [record.id],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ reason: "immediate_undo" });
  });
  it("never treats a historical operation without persisted provenance as immediate undo", async () => {
    const family = await createFamily("historical-undo");
    const inserted = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, source, confirmation, sensitivity, operation_key)
       VALUES ($1, $2, $2, $3, 'personal', 'fact', 'Историческая запись', 'eve:legacy',
               'user_confirmed', 'normal', 'historical-create')
       RETURNING id`,
      [family.familyId, family.owner.userId, family.owner.telegramUserId],
    );
    await database().query(
      `INSERT INTO memory_mutation_operations
         (family_id, operation_key, mutation_kind, input_hash, memory_item_id)
       VALUES ($1, 'historical-create', 'create', $2, $3)`,
      [family.familyId, memoryOperationHash({ historical: true }), inserted.rows[0]!.id],
    );
    const reference = await database().query<{ memory_ref: string }>(
      "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1",
      [inserted.rows[0]!.id],
    );
    await expect(memoryRepository.canUndoCreate(
      family.owner,
      reference.rows[0]!.memory_ref,
      { sessionId: "legacy", turnId: "legacy" },
    )).resolves.toBe(false);
  });

  it("enforces the configured personal quota before inserting another record", async () => {
    const family = await createFamily("quota");
    await database().query(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, source, confirmation, sensitivity, operation_key)
       SELECT $1, $2, $2, $3, 'personal', 'fact', 'Факт ' || value::text,
              'test:quota', 'user_confirmed', 'normal', 'quota-' || value::text
       FROM generate_series(1, $4) AS value`,
      [family.familyId, family.owner.userId, family.owner.telegramUserId, MEMORY_SCOPE_QUOTAS.personal],
    );

    await expect(
      memoryRepository.create(family.owner, createInput("personal", "over-quota")),
    ).rejects.toThrowError(/AGENT_MEMORY_QUOTA_EXCEEDED/);
  });

  it("hides the memory and drops its embedding job while keeping it recoverable", async () => {
    const family = await createFamily("delete");
    const record = await memoryRepository.create(
      family.owner,
      createInput("personal", "delete-create", "Секретное описание без учётных данных"),
    );

    await expect(
      memoryRepository.deleteByRef(family.owner, record.memoryRef, "delete-call"),
    ).resolves.toEqual({ deleted: true });
    const persisted = await database().query(
      "SELECT 1 FROM memory_items WHERE id = $1",
      [record.id],
    );
    const jobs = await database().query(
      "SELECT 1 FROM memory_embedding_jobs WHERE memory_item_id = $1",
      [record.id],
    );
    const audit = await database().query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE subject_id = $1 AND event_type = 'memory.deleted'",
      [record.id],
    );

    const retained = await database().query(
      "SELECT deleted_at FROM memory_items_all WHERE id = $1",
      [record.id],
    );

    expect(persisted.rowCount).toBe(0);
    expect(jobs.rowCount).toBe(0);
    // Удаление мягкое: строка остаётся восстановимой до истечения окна ретенции.
    expect(retained.rowCount).toBe(1);
    expect(audit.rows[0]?.metadata).not.toHaveProperty("content");
  });
});
