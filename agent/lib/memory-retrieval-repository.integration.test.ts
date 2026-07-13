/**
 * PostgreSQL hybrid retrieval integration tests.
 *
 * Constructs covered:
 * - Full-text and best-chunk vector candidates are fused once per parent record.
 * - Personal and family authorization is applied before ranking.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { MemoryAuthorization } from "./memory-context.js";
import { closeDatabase, database } from "./database.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_VERSION,
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
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items, family_memberships, users, families CASCADE",
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
    await insert(auth.userId!, auth.telegramUserId, "Пользователь не ест орехи", [vector(0, 1), vector(1, 0)], "visible");
    await insert(auth.userId!, auth.telegramUserId, "Любимый транспорт — поезд", [vector(0, 1)], "irrelevant");
    await insert(otherUserId, "search-other", "Скрытая аллергия на орехи", [vector(1, 0)], "hidden");

    const results = await memoryRetrievalRepository.search(
      auth,
      "Что нельзя добавлять в десерт с орехами?",
      vector(1, 0),
    );

    expect(results[0]?.content).toBe("Пользователь не ест орехи");
    expect(results.filter((item) => item.content === "Пользователь не ест орехи")).toHaveLength(1);
    expect(results.map((item) => item.content)).not.toContain("Скрытая аллергия на орехи");
  });
});
