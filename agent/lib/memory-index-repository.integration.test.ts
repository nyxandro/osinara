/**
 * PostgreSQL memory embedding queue integration tests.
 *
 * Constructs covered:
 * - Pending records are leased once and atomically completed with all E5 chunks.
 * - Stale lease results cannot overwrite a newer memory version.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_LEASE_MILLISECONDS,
  MEMORY_EMBEDDING_MODEL_VERSION,
} from "./memory-config.js";
import { memoryIndexRepository } from "./memory-index-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;
if (integrationTestsEnabled && (!integrationDatabaseUrl || !new URL(integrationDatabaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

async function insertPendingMemory(): Promise<string> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Индекс') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('index-owner', 'Владелец') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  const memory = await database().query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
        content, source, confirmation, sensitivity, operation_key)
     VALUES ($1, $2, $2, 'index-owner', 'personal', 'fact', 'Поездка в Казань',
             'test:index', 'user_confirmed', 'normal', 'index-operation')
     RETURNING id`,
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  await database().query(
    "INSERT INTO memory_embedding_jobs (memory_item_id) VALUES ($1)",
    [memory.rows[0]!.id],
  );
  return memory.rows[0]!.id;
}

describeWithDatabase("memoryIndexRepository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("leases and atomically stores all correctly sized chunks", async () => {
    const memoryId = await insertPendingMemory();
    const jobs = await memoryIndexRepository.claim(8, MEMORY_EMBEDDING_LEASE_MILLISECONDS);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ content: "Поездка в Казань", memoryItemId: memoryId });
    await memoryIndexRepository.complete(
      memoryId,
      jobs[0]!.leaseToken,
      [
        {
          chunkIndex: 0,
          content: "Поездка",
          embedding: Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0.125),
          endOffset: 7,
          startOffset: 0,
        },
        {
          chunkIndex: 1,
          content: "в Казань",
          embedding: Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0.25),
          endOffset: 16,
          startOffset: 8,
        },
      ],
      MEMORY_EMBEDDING_MODEL_VERSION,
    );
    const stored = await database().query<{
      dimensions: number;
      embedding_model: string;
      embedding_status: string;
    }>(
      `SELECT vector_dims(chunk.embedding) AS dimensions, chunk.embedding_model,
              item.embedding_status
       FROM memory_items AS item
       JOIN memory_embedding_chunks AS chunk ON chunk.memory_item_id = item.id
       WHERE item.id = $1
       ORDER BY chunk.chunk_index`,
      [memoryId],
    );
    expect(stored.rows).toEqual([
      {
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
        embedding_model: MEMORY_EMBEDDING_MODEL_VERSION,
        embedding_status: "indexed",
      },
      {
        dimensions: MEMORY_EMBEDDING_DIMENSIONS,
        embedding_model: MEMORY_EMBEDDING_MODEL_VERSION,
        embedding_status: "indexed",
      },
    ]);
    await expect(memoryIndexRepository.claim(8, MEMORY_EMBEDDING_LEASE_MILLISECONDS)).resolves.toEqual([]);
  });

  it("rejects a stale completion after an edit resets the job", async () => {
    const memoryId = await insertPendingMemory();
    const [job] = await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);
    await database().query(
      `UPDATE memory_embedding_jobs
       SET status = 'pending', attempts = 0, lease_token = NULL, lease_expires_at = NULL
       WHERE memory_item_id = $1`,
      [memoryId],
    );

    await expect(
      memoryIndexRepository.complete(
        memoryId,
        job!.leaseToken,
        [{
          chunkIndex: 0,
          content: "Поездка в Казань",
          embedding: Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0),
          endOffset: 16,
          startOffset: 0,
        }],
        MEMORY_EMBEDDING_MODEL_VERSION,
      ),
    ).resolves.toBe(false);
    const chunks = await database().query(
      "SELECT 1 FROM memory_embedding_chunks WHERE memory_item_id = $1",
      [memoryId],
    );
    expect(chunks.rowCount).toBe(0);
  });
});
