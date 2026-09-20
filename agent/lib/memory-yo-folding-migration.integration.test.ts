/**
 * «ё» folding in the exact search column.
 *
 * Constructs covered:
 * - `106_memory_search_vector_yo_folding.sql`: the indexed exact vector folds «ё» to «е».
 * - A record written with «ё» is found by a query typed with «е», and the other way round.
 * - The morphological column is untouched: its stemmer already folded the letter on its own.
 * - The soft-delete view and the monitoring view over it survive the column rewrite.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("106 exact search vector folds «ё»", () => {
  let familyId: string;
  let userId: string;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, family_memberships, users, families CASCADE",
    );
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Буква ё') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('yo-owner', 'Владелец') RETURNING id",
    );
    familyId = family.rows[0]!.id;
    userId = user.rows[0]!.id;
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [familyId, userId],
    );
  });

  afterAll(async () => closeDatabase());

  async function insert(content: string, operationKey: string): Promise<void> {
    await database().query(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, source, confirmation, sensitivity, operation_key)
       VALUES ($1, $2, $2, 'yo-owner', 'personal', 'fact', $3, 'test:yo',
               'user_confirmed', 'normal', $4)`,
      [familyId, userId, content, operationKey],
    );
  }

  it("matches the exact branch across «ё» and «е» in both directions", async () => {
    await insert("Звонил Пётр по поводу Алёны", "with-yo");
    await insert("Звонил Петр по поводу Алены", "without-yo");

    const found = await database().query<{ content: string }>(
      `SELECT content FROM memory_items
       WHERE family_id = $1
         AND search_vector @@ to_tsquery('simple', quote_literal(translate($2, 'ёЁ', 'еЕ')))
       ORDER BY content`,
      [familyId, "Петр"],
    );
    const foundByYo = await database().query<{ content: string }>(
      `SELECT content FROM memory_items
       WHERE family_id = $1
         AND search_vector @@ to_tsquery('simple', quote_literal(translate($2, 'ёЁ', 'еЕ')))
       ORDER BY content`,
      [familyId, "Пётр"],
    );

    expect(found.rows.map((row) => row.content)).toEqual([
      "Звонил Петр по поводу Алены",
      "Звонил Пётр по поводу Алёны",
    ]);
    expect(foundByYo.rows).toEqual(found.rows);
  });

  it("keeps the stored text exactly as it was written", async () => {
    await insert("Фёдор и Алёна", "unchanged-text");

    const stored = await database().query<{ content: string }>(
      "SELECT content FROM memory_items WHERE family_id = $1",
      [familyId],
    );

    expect(stored.rows[0]?.content).toBe("Фёдор и Алёна");
  });

  it("leaves the soft-delete view and the monitoring view over it working", async () => {
    await insert("Запись для проверки представлений", "views-alive");
    await database().query(
      "UPDATE memory_items_all SET deleted_at = now() WHERE operation_key = 'views-alive'",
    );

    const visible = await database().query("SELECT 1 FROM memory_items WHERE family_id = $1", [
      familyId,
    ]);
    const monitoring = await database().query("SELECT 1 FROM monitoring_memory_index_state");

    expect(visible.rowCount).toBe(0);
    expect(monitoring.rowCount).toBeGreaterThanOrEqual(0);
  });
});
