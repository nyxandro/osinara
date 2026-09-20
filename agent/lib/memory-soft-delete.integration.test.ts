/**
 * Soft-deleted memory integration tests.
 *
 * Constructs covered:
 * - `memory_items` — представление: мягко удалённая строка исчезает из чтений и из векторной выдачи.
 * - Базовая строка сохраняется, поэтому удаление обратимо до истечения окна восстановления.
 * - `purgeSoftDeletedMemory`: физически убирает только строки старше окна.
 * - Представление не отстаёт от базовой таблицы по набору колонок.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MEMORY_SOFT_DELETE_RETENTION_DAYS } from "../config.js";
import { closeDatabase, database } from "./database.js";
import { purgeSoftDeletedMemory } from "./memory-retention.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const NOW = new Date("2026-08-24T12:00:00.000Z");

async function insertFact(content: string): Promise<string> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Мягкое удаление') RETURNING id",
  );
  const item = await database().query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, scope, content, source, kind, sensitivity, confirmation, operation_key)
     VALUES ($1, 'family', $2, 'test', 'fact', 'normal', 'user_confirmed', $3)
     RETURNING id`,
    [family.rows[0]!.id, content, `op-${content}`],
  );
  return item.rows[0]!.id;
}

async function softDelete(id: string, deletedAt: Date): Promise<void> {
  await database().query(
    "UPDATE memory_items_all SET deleted_at = $2 WHERE id = $1",
    [id, deletedAt],
  );
}

describeWithDatabase("soft-deleted memory", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_items_all, families CASCADE",
    );
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => closeDatabase());

  it("keeps the view in step with the base table", async () => {
    // `SELECT *` разворачивается при создании представления: новая колонка базовой таблицы сюда
    // сама не попадёт, и запись, упоминающая её, начнёт падать. Этот тест ловит такой дрейф.
    const columns = await database().query<{ relation: string; column_name: string }>(
      `SELECT table_name AS relation, column_name
         FROM information_schema.columns
        WHERE table_name IN ('memory_items', 'memory_items_all')`,
    );
    const base = columns.rows.filter((row) => row.relation === "memory_items_all")
      .map((row) => row.column_name).sort();
    const view = columns.rows.filter((row) => row.relation === "memory_items")
      .map((row) => row.column_name).sort();

    expect(base.length).toBeGreaterThan(0);
    expect(view).toEqual(base);
  });

  it("hides a softly deleted fact from reads while keeping it recoverable", async () => {
    const id = await insertFact("первый факт");

    await expect(
      database().query("SELECT id FROM memory_items WHERE id = $1", [id]),
    ).resolves.toMatchObject({ rowCount: 1 });

    await softDelete(id, NOW);

    const visible = await database().query("SELECT id FROM memory_items WHERE id = $1", [id]);
    const stored = await database().query("SELECT id FROM memory_items_all WHERE id = $1", [id]);
    expect(visible.rowCount).toBe(0);
    expect(stored.rowCount).toBe(1);
  });

  it("removes a softly deleted fact from the vector retrieval join", async () => {
    const id = await insertFact("факт с эмбеддингом");
    await database().query(
      `INSERT INTO memory_embedding_chunks
         (memory_item_id, chunk_index, content, embedding_input, start_offset, end_offset,
            embedding, embedding_model)
       VALUES ($1, 0, 'факт с эмбеддингом', 'факт с эмбеддингом', 0, 18,
               array_fill(0.1, ARRAY[384])::vector, 'e5')`,
      [id],
    );
    const ragCount = async (): Promise<number> => {
      const result = await database().query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM memory_items item
           JOIN memory_embedding_chunks chunk ON chunk.memory_item_id = item.id`,
      );
      return Number(result.rows[0]!.count);
    };

    expect(await ragCount()).toBe(1);

    await softDelete(id, NOW);

    // Чанк остаётся ради восстановления, но соединение идёт через представление.
    expect(await ragCount()).toBe(0);
    const chunks = await database().query("SELECT 1 FROM memory_embedding_chunks WHERE memory_item_id = $1", [id]);
    expect(chunks.rowCount).toBe(1);
  });

  it("purges only what has outlived the recovery window", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fresh = await insertFact("свежее удаление");
    const old = await insertFact("старое удаление");
    const beyond = new Date(
      NOW.getTime() - (MEMORY_SOFT_DELETE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1_000,
    );
    await softDelete(fresh, NOW);
    await softDelete(old, beyond);

    await expect(purgeSoftDeletedMemory(NOW)).resolves.toBe(1);
    expect(info).toHaveBeenCalledWith(JSON.stringify({
      code: "AGENT_MEMORY_PURGE_COMPLETED",
      deletedCount: 1,
      batchLimitReached: false,
    }));
    const remaining = await database().query<{ id: string }>("SELECT id FROM memory_items_all");
    expect(remaining.rows.map((row) => row.id)).toEqual([fresh]);
  });
});
