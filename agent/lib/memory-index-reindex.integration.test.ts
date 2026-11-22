/**
 * Re-indexing records that already have a vector (#556).
 *
 * Constructs covered:
 * - A record without a vector is claimed before a queued re-index of one that has it, so a new fact
 *   does not wait behind a migration that rebuilds three thousand vectors.
 * - A failed or abandoned re-index keeps the previous vector and the record stays in semantic search:
 *   a record's text never changes in place, so its vector still describes it. A record that never had
 *   a vector fails as before.
 * - The header names the person the record is bound to, as Telegram names them now.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_LEASE_MILLISECONDS,
  MEMORY_EMBEDDING_MODEL_VERSION,
} from "./memory-config.js";
import { memoryIndexRepository } from "./memory-index-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function owner(): Promise<{ familyId: string; userId: string }> {
  const familyId = (await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Переиндексация') RETURNING id",
  )).rows[0]!.id;
  const userId = (await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name, telegram_username)
     VALUES ('reindex-owner', 'Нина Соколова', 'nina_s') RETURNING id`,
  )).rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, userId],
  );
  return { familyId, userId };
}

/** A personal record about its owner; `indexed` gives it a stored vector, as before the migration. */
async function record(
  who: { familyId: string; userId: string },
  key: string,
  options: { indexed: boolean; bound?: boolean },
): Promise<string> {
  const id = (await database().query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind, content, source,
        confirmation, sensitivity, operation_key, embedding_status, subject_user_id)
     VALUES ($1, $2, $2, 'reindex-owner', 'personal', 'fact', 'Поездка в Казань', 'test:reindex',
             'user_confirmed', 'normal', $3, $4, $5)
     RETURNING id`,
    [who.familyId, who.userId, key, options.indexed ? "indexed" : "pending", options.bound ? who.userId : null],
  )).rows[0]!.id;
  if (options.indexed) {
    await database().query(
      `INSERT INTO memory_embedding_chunks
         (memory_item_id, chunk_index, content, embedding_input, start_offset, end_offset, embedding,
          embedding_model)
       VALUES ($1, 0, 'Поездка в Казань', 'Вид: факт. Поездка в Казань', 0, 16, $2::vector, $3)`,
      [id, `[${Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0.125).join(",")}]`,
        MEMORY_EMBEDDING_MODEL_VERSION],
    );
  }
  await database().query("INSERT INTO memory_embedding_jobs (memory_item_id) VALUES ($1)", [id]);
  return id;
}

async function state(id: string) {
  return (await database().query<{ chunks: number; embedding_status: string; job_status: string }>(
    `SELECT item.embedding_status, job.status AS job_status,
            (SELECT count(*)::integer FROM memory_embedding_chunks WHERE memory_item_id = item.id) AS chunks
     FROM memory_items AS item JOIN memory_embedding_jobs AS job ON job.memory_item_id = item.id
     WHERE item.id = $1`,
    [id],
  )).rows[0]!;
}

describeWithDatabase("re-indexing a record that has a vector", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("claims a record without a vector before an older re-index", async () => {
    const who = await owner();
    await record(who, "reindex-old", { indexed: true });
    const fresh = await record(who, "reindex-new", { indexed: false });

    const [first] = await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);

    expect(first?.memoryItemId).toBe(fresh);
  });

  it("keeps the previous vector when the re-index fails", async () => {
    const who = await owner();
    const indexed = await record(who, "reindex-failed", { indexed: true });
    const [job] = await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);

    await memoryIndexRepository.fail(indexed, job!.leaseToken, "AGENT_MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE");

    expect(await state(indexed)).toEqual({ chunks: 1, embedding_status: "indexed", job_status: "failed" });
  });

  it("keeps the previous vector when the re-index was abandoned", async () => {
    const who = await owner();
    const indexed = await record(who, "reindex-expired", { indexed: true });
    await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);
    await database().query(
      "UPDATE memory_embedding_jobs SET lease_expires_at = now() - interval '1 minute' WHERE memory_item_id = $1",
      [indexed],
    );

    await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);

    expect(await state(indexed)).toEqual({ chunks: 1, embedding_status: "indexed", job_status: "failed" });
  });

  it("fails a record that never had a vector as before", async () => {
    const who = await owner();
    const fresh = await record(who, "reindex-never", { indexed: false });
    const [job] = await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);

    await memoryIndexRepository.fail(fresh, job!.leaseToken, "AGENT_MEMORY_EMBEDDING_INPUT_TOO_LONG");

    expect(await state(fresh)).toEqual({ chunks: 0, embedding_status: "failed", job_status: "failed" });
  });

  it("names the bound person in the header", async () => {
    const who = await owner();
    await record(who, "reindex-bound", { bound: true, indexed: true });

    const [job] = await memoryIndexRepository.claim(1, MEMORY_EMBEDDING_LEASE_MILLISECONDS);

    expect(job?.subjectLabel).toBe("Нина Соколова (@nina_s)");
  });
});
