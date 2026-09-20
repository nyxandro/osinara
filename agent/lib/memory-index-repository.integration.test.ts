/**
 * PostgreSQL memory embedding queue integration tests.
 *
 * Constructs covered:
 * - Pending records are leased once and atomically completed with all E5 chunks.
 * - Stale lease results cannot overwrite a newer memory version.
 * - A failure that was only the service being away returns to the queue, bounded and delayed.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_LEASE_MILLISECONDS,
  MEMORY_EMBEDDING_MAX_ATTEMPTS,
  MEMORY_EMBEDDING_MODEL_VERSION,
} from "./memory-config.js";
import { memoryIndexRepository } from "./memory-index-repository.js";
import { chunkMemoryContent } from "./memory-embedding-chunks.js";

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
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, family_memberships, users, families CASCADE",
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

  /** Moves a job's clock back so the bounded retry delay counts as elapsed. */
  async function backdateJob(memoryItemId: string): Promise<void> {
    await database().query(
      "UPDATE memory_embedding_jobs SET updated_at = now() - interval '1 hour' WHERE memory_item_id = $1",
      [memoryItemId],
    );
  }

  it("returns a record to the queue when only the embedding service was away", async () => {
    const memoryId = await insertPendingMemory();
    const [first] = await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);
    await memoryIndexRepository.fail(
      memoryId,
      first!.leaseToken,
      "AGENT_MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE",
    );

    // Still failed, and still invisible to semantic search, until the delay has passed.
    await expect(memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS))
      .resolves.toEqual([]);
    await backdateJob(memoryId);
    const [retried] = await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);

    expect(retried).toMatchObject({
      attempts: 2,
      content: "Поездка в Казань",
      memoryItemId: memoryId,
    });
  });

  it.each([
    ["текст отвергнут сервисом", "AGENT_MEMORY_EMBEDDING_PROVIDER_FAILED"],
    ["исход попытки неизвестен", "AGENT_MEMORY_EMBEDDING_LEASE_EXPIRED"],
  ])("never retries when %s", async (_reason, errorCode) => {
    const memoryId = await insertPendingMemory();
    const [job] = await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);
    await memoryIndexRepository.fail(memoryId, job!.leaseToken, errorCode);
    await backdateJob(memoryId);

    await expect(memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS))
      .resolves.toEqual([]);
  });

  it("counts every attempt and stops at the bound instead of retrying forever", async () => {
    const memoryId = await insertPendingMemory();
    const observedAttempts: number[] = [];

    // The loop is what proves the bound: each pass fails for the same transient reason and is
    // allowed back in, so a counter that stopped advancing would never leave this loop.
    for (let pass = 0; pass < MEMORY_EMBEDDING_MAX_ATTEMPTS + 1; pass += 1) {
      const [job] = await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);
      if (job === undefined) break;
      observedAttempts.push(job.attempts);
      await memoryIndexRepository.fail(
        memoryId,
        job.leaseToken,
        "AGENT_MEMORY_EMBEDDING_PROVIDER_BUSY",
      );
      await backdateJob(memoryId);
    }

    expect(observedAttempts).toEqual(
      Array.from({ length: MEMORY_EMBEDDING_MAX_ATTEMPTS }, (_, index) => index + 1),
    );
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

  it("stores Unicode-safe overlapping chunks without changing the memory text", async () => {
    const memoryId = await insertPendingMemory();
    const content = "а".repeat(319) + "😀🧑🏽‍💻".repeat(75) + "б".repeat(500);
    await database().query("UPDATE memory_items SET content = $2 WHERE id = $1", [memoryId, content]);
    const [job] = await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);
    const chunks = chunkMemoryContent(job!.content);
    await expect(memoryIndexRepository.complete(
      memoryId,
      job!.leaseToken,
      chunks.map((chunk) => ({
        ...chunk,
        embedding: Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0.125),
      })),
      MEMORY_EMBEDDING_MODEL_VERSION,
    )).resolves.toBe(true);
    expect((await database().query("SELECT content,embedding_status FROM memory_items WHERE id=$1", [memoryId])).rows)
      .toEqual([{ content, embedding_status: "indexed" }]);
    const stored = (await database().query<{ content: string; start_offset: number; end_offset: number }>(
      "SELECT content,start_offset,end_offset FROM memory_embedding_chunks WHERE memory_item_id=$1 ORDER BY chunk_index",
      [memoryId],
    )).rows;
    expect(stored).toHaveLength(chunks.length);
    for (const chunk of stored) {
      expect(chunk.content).not.toMatch(/[\uD800-\uDFFF]/u);
      expect(chunk.content).toBe(content.slice(chunk.start_offset, chunk.end_offset));
    }
    expect((await database().query("SELECT 1 FROM memory_embedding_jobs WHERE memory_item_id=$1", [memoryId])).rowCount).toBe(0);
  });
});
