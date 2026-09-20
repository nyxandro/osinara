/**
 * PostgreSQL hybrid retrieval integration tests.
 *
 * Constructs covered:
 * - Full-text and best-chunk vector candidates are fused once per parent record.
 * - Personal and family authorization is applied before ranking.
 * - Unresolved conflict closure loads both authorized versions even when one has no retrieval score.
 * - Conflict closure withholds base results when authorization changes between repository queries.
 * - Branch diagnostics report pre-threshold scores, matches, and what passed each gate.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryAuthorization } from "./memory-context.js";
import { closeDatabase, database } from "./database.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_VERSION,
  MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY,
} from "./memory-config.js";
import { memoryRetrievalRepository } from "./memory-retrieval-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

function vector(first: number, second: number): number[] {
  return [first, second, ...Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS - 2 }, () => 0)];
}

describeWithDatabase("memoryRetrievalRepository", () => {
  let auth: MemoryAuthorization;
  let otherUserId: string;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, family_memberships, users, families CASCADE",
    );
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Поиск') RETURNING id",
    );
    const users = await database().query<{ id: string; telegram_user_id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('search-owner', 'Владелец'), ('search-other', 'Другой')
       RETURNING id, telegram_user_id`,
    );
    const owner = users.rows.find((row) => row.telegram_user_id === "search-owner")!;
    otherUserId = users.rows.find((row) => row.telegram_user_id === "search-other")!.id;
    await database().query(
      `INSERT INTO family_memberships (family_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [family.rows[0]!.id, owner.id, otherUserId],
    );
    auth = {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramActorId: "search-owner",
      telegramActorKind: "telegram_user",
      telegramUserId: "search-owner",
      userId: owner.id,
    };
  });

  afterAll(async () => closeDatabase());

  it("finds a semantically and lexically relevant record without disclosing another user's personal record", async () => {
    const insert = async (ownerUserId: string, telegramUserId: string, content: string, embeddings: number[][], key: string) => {
      const memory = await database().query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
             content, source, confirmation, sensitivity, operation_key, embedding_status)
         VALUES ($1, $2, $2, $3, 'personal', 'fact', $4, 'test:search',
                  'user_confirmed', 'normal', $5, 'indexed')
         RETURNING id`,
        [auth.familyId, ownerUserId, telegramUserId, content, key],
      );
      for (const [chunkIndex, embedding] of embeddings.entries()) {
        await database().query(
          `INSERT INTO memory_embedding_chunks
             (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
           VALUES ($1, $2, $3, 0, $4, $5::vector, $6)`,
          [memory.rows[0]!.id, chunkIndex, `${content}:${chunkIndex}`, content.length, `[${embedding.join(",")}]`, MEMORY_EMBEDDING_MODEL_VERSION],
        );
      }
    };
    await insert(auth.userId!, auth.telegramActorId, "Пользователь не ест орехи", [vector(0, 1), vector(1, 0)], "visible");
    await insert(auth.userId!, auth.telegramActorId, "Любимый транспорт — поезд", [vector(0, 1)], "irrelevant");
    await insert(otherUserId, "search-other", "Скрытая аллергия на орехи", [vector(1, 0)], "hidden");

    const { results } = await memoryRetrievalRepository.search(
      auth,
      "орехами",
      vector(1, 0),
    );

    expect(results[0]?.memory.content).toBe("Пользователь не ест орехи");
    expect(results.filter((result) => result.memory.content === "Пользователь не ест орехи"))
      .toHaveLength(1);
    expect(results.map((result) => result.memory.content)).not.toContain("Скрытая аллергия на орехи");
    expect(results[0]?.evidence.russianMorphologyRank).not.toBeNull();
  });

  it("reports the branch scores that the thresholds cut off, even when nothing is returned", async () => {
    const memory = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, source, confirmation, sensitivity, operation_key, embedding_status)
       VALUES ($1, $2, $2, $3, 'personal', 'fact', 'Пользователь не ест орехи',
               'test:diagnostics', 'user_confirmed', 'normal', 'diagnostics', 'indexed')
       RETURNING id`,
      [auth.familyId, auth.userId, auth.telegramUserId],
    );
    await database().query(
      `INSERT INTO memory_embedding_chunks
         (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
       VALUES ($1, 0, 'Пользователь не ест орехи', 0, 25, $2::vector, $3)`,
      [memory.rows[0]!.id, `[${vector(0, 1).join(",")}]`, MEMORY_EMBEDDING_MODEL_VERSION],
    );

    // Orthogonal query vector and unrelated wording: every branch scores below its own gate.
    const { diagnostics, results } = await memoryRetrievalRepository.search(
      auth,
      "велосипед",
      vector(1, 0),
    );

    expect(results).toEqual([]);
    expect(diagnostics.semanticTopSimilarity).not.toBeNull();
    expect(diagnostics.semanticTopSimilarity!)
      .toBeLessThan(MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY);
    expect(diagnostics).toMatchObject({
      candidateLimitHit: false,
      russianQualified: 0,
      russianMatched: 0,
      russianTopRank: null,
      // The semantic branch did look at the record and scored it; the gate is what dropped it.
      semanticQualified: 0,
      semanticMatched: 1,
      simpleQualified: 0,
      simpleMatched: 0,
      simpleTopRank: null,
    });
  });

  it("loads an unresolved low-score conflict partner as one complete opaque group", async () => {
    const first = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, content_normalized, source, confirmation, sensitivity, operation_key,
          embedding_status)
       VALUES ($1, $2, $2, $3, 'personal', 'fact', 'Код домофона 1234',
               'код домофона 1234', 'test:conflict', 'user_confirmed', 'normal',
               'conflict-visible', 'indexed') RETURNING id`,
      [auth.familyId, auth.userId, auth.telegramUserId],
    );
    const second = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, content_normalized, source, confirmation, sensitivity, operation_key)
       VALUES ($1, $2, $2, $3, 'personal', 'fact', 'Код домофона 9876',
               'код домофона 9876', 'test:conflict', 'user_confirmed', 'normal',
               'conflict-low-score') RETURNING id`,
      [auth.familyId, auth.userId, auth.telegramUserId],
    );
    await database().query(
      `INSERT INTO memory_embedding_chunks
         (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
       VALUES ($1, 0, 'Код домофона 1234', 0, 18, $2::vector, $3)`,
      [first.rows[0]!.id, `[${vector(1, 0).join(",")}]`, MEMORY_EMBEDDING_MODEL_VERSION],
    );
    await database().query(
      `INSERT INTO claim_conflicts
         (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3,
               'personal', $4, 'deterministic_guard')`,
      [first.rows[0]!.id, second.rows[0]!.id, auth.familyId, auth.userId],
    );

    const result = await memoryRetrievalRepository.searchWithConflictClosure(
      auth,
      "домофон 1234",
      vector(1, 0),
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.conflictRef).toMatch(/^conf_[0-9a-f]{32}$/u);
    expect(result.conflicts[0]?.versions.map((version) => version.content).sort()).toEqual([
      "Код домофона 1234",
      "Код домофона 9876",
    ]);
    expect(JSON.stringify(result.conflicts)).not.toContain(first.rows[0]!.id);
    expect(JSON.stringify(result.conflicts)).not.toContain(second.rows[0]!.id);
  });

  it("withholds mixed conflict and ordinary results after mid-query membership revocation", async () => {
    const first = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, content_normalized, source, confirmation, sensitivity, operation_key,
          embedding_status)
       VALUES ($1, $2, $2, $3, 'personal', 'fact', 'Код сейфа 1234', 'код сейфа 1234',
               'test:live-conflict', 'user_confirmed', 'normal', 'live-conflict-visible',
               'indexed') RETURNING id`,
      [auth.familyId, auth.userId, auth.telegramUserId],
    );
    const second = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, content_normalized, source, confirmation, sensitivity, operation_key)
       VALUES ($1, $2, $2, $3, 'personal', 'fact', 'Другая версия 9876',
               'другая версия 9876', 'test:live-conflict', 'user_confirmed', 'normal',
               'live-conflict-partner') RETURNING id`,
      [auth.familyId, auth.userId, auth.telegramUserId],
    );
    const ordinary = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, content_normalized, source, confirmation, sensitivity, operation_key,
          embedding_status, subject_user_id)
       VALUES ($1, $2, $2, $3, 'personal', 'fact', 'Обычная заметка про сейф',
               'обычная заметка про сейф', 'test:live-conflict', 'user_confirmed', 'normal',
               'live-conflict-ordinary', 'indexed', $2) RETURNING id`,
      [auth.familyId, auth.userId, auth.telegramUserId],
    );
    await database().query(
      `INSERT INTO memory_embedding_chunks
         (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
       VALUES ($1, 0, 'Код сейфа 1234', 0, 14, $2::vector, $3)`,
      [first.rows[0]!.id, `[${vector(1, 0).join(",")}]`, MEMORY_EMBEDDING_MODEL_VERSION],
    );
    await database().query(
      `INSERT INTO claim_conflicts
         (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3,
               'personal', $4, 'deterministic_guard')`,
      [first.rows[0]!.id, second.rows[0]!.id, auth.familyId, auth.userId],
    );
    await database().query(
      `INSERT INTO memory_embedding_chunks
         (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
       VALUES ($1, 0, 'Обычная заметка про сейф', 0, 25, $2::vector, $3)`,
      [ordinary.rows[0]!.id, `[${vector(1, 0).join(",")}]`, MEMORY_EMBEDDING_MODEL_VERSION],
    );

    const beforeRevocation = await memoryRetrievalRepository.search(
      auth,
      "код сейфа 1234",
      vector(1, 0),
    );
    expect(beforeRevocation.results.map((result) => result.memory.id)).toEqual(expect.arrayContaining([
      first.rows[0]!.id,
      ordinary.rows[0]!.id,
    ]));

    // Revoke through the real database immediately after base search returns, before closure SQL.
    const pool = database();
    const originalQuery = pool.query.bind(pool) as (
      queryText: string,
      values?: unknown[],
    ) => ReturnType<typeof pool.query>;
    let revoked = false;
    const querySpy = vi.spyOn(pool, "query").mockImplementation((async (
      queryText: string,
      values?: unknown[],
    ) => {
      const result = await originalQuery(queryText, values);
      if (!revoked && queryText.includes("WITH authorized AS NOT MATERIALIZED")) {
        revoked = true;
        await originalQuery(
          "DELETE FROM family_memberships WHERE family_id = $1 AND user_id = $2",
          [auth.familyId, auth.userId],
        );
      }
      return result;
    }) as typeof pool.query);
    try {
      await expect(memoryRetrievalRepository.searchWithConflictClosure(
        auth,
        "код сейфа 1234",
        vector(1, 0),
      )).resolves.toMatchObject({ conflicts: [], relatedClaimIds: [], results: [] });
      expect(revoked).toBe(true);
    } finally {
      querySpy.mockRestore();
    }
  });
});
