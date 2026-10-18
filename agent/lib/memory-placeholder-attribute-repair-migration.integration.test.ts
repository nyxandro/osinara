/**
 * Placeholder slot repair migration integration test.
 *
 * Constructs covered:
 * - `133_memory_placeholder_attribute_repair.sql`: a record retired through the slot "null" is
 *   active again and no longer points at the record that retired it, along a whole chain.
 * - Every "null", "none" and "undefined" slot is cleared, whatever the record's status.
 * - The history of a real slot and a correction stay exactly as they were.
 * - A record the person deleted stays deleted; clearing a slot does not touch `updated_at`.
 *
 * On production the silent review stored ten records with the slot "null" (23.09 and 02.10.2026),
 * and three of them were retired by unrelated facts about the same person: a fan of TDD retired by
 * a note about how he hires people.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("133 placeholder slot repair", () => {
  let familyId: string;
  let groupId: string;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_items_all, application_conversations, telegram_groups, families CASCADE",
    );
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Слоты') RETURNING id",
    );
    familyId = family.rows[0]!.id;
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, 'slot-repair-chat', 'Рабочий чат', 'external', 'all') RETURNING id`,
      [familyId],
    );
    groupId = group.rows[0]!.id;
  });

  afterAll(async () => closeDatabase());

  async function store(content: string, attribute: string | null): Promise<string> {
    const row = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, group_id, author_telegram_user_id, scope, kind, content, source,
          confirmation, sensitivity, operation_key, attribute, subject_label)
       VALUES ($1, $2, 'slot-author', 'group', 'preference', $3, 'test:slot-repair', 'model_high',
               'normal', $3, $4, 'Участник (member)')
       RETURNING id`,
      [familyId, groupId, content, attribute],
    );
    return row.rows[0]!.id;
  }

  /** Writes the retirement the way the application does: the pointer and its readable relation. */
  async function retire(
    previous: string,
    by: string,
    relation: "correction" | "temporal_update",
    metadata: Record<string, string>,
  ): Promise<void> {
    await database().query(
      "UPDATE memory_items SET claim_status = 'superseded', superseded_by = $2 WHERE id = $1",
      [previous, by],
    );
    await database().query(
      `INSERT INTO claim_relations
         (source_claim_id, target_claim_id, family_id, scope, scope_partition_key,
          relation_type, detection_method, detection_metadata)
       SELECT id, $2, family_id, scope, scope_partition_key, $3::claim_relation_type,
              'model_guarded', $4::jsonb
       FROM memory_items_all WHERE id = $1`,
      [previous, by, relation, JSON.stringify(metadata)],
    );
  }

  async function runMigration(): Promise<void> {
    const sql = await readFile(resolve("migrations/133_memory_placeholder_attribute_repair.sql"), "utf8");
    await database().query(sql);
  }

  async function stateOf(id: string) {
    const row = await database().query<{
      attribute: string | null;
      claim_status: string;
      superseded_by: string | null;
    }>("SELECT attribute, claim_status, superseded_by FROM memory_items_all WHERE id = $1", [id]);
    return row.rows[0]!;
  }

  async function relationsOf(id: string): Promise<string[]> {
    const rows = await database().query<{ relation_type: string }>(
      "SELECT relation_type::text FROM claim_relations WHERE source_claim_id = $1 ORDER BY 1",
      [id],
    );
    return rows.rows.map((row) => row.relation_type);
  }

  it("brings back every record a placeholder slot retired, along the whole chain", async () => {
    const fan = await store("Большой фанат TDD", "null");
    const hiring = await store("Нанимает людей, в чей код может не смотреть", "null");
    const reviews = await store("Работу описывает как бесконечное ревью", "null");
    await retire(fan, hiring, "temporal_update", { attribute: "null" });
    await retire(hiring, reviews, "temporal_update", { attribute: "null" });

    await runMigration();

    for (const id of [fan, hiring, reviews]) {
      expect(await stateOf(id)).toEqual({ attribute: null, claim_status: "active", superseded_by: null });
      expect(await relationsOf(id)).toEqual([]);
    }
  });

  it("clears none and undefined the same way and leaves a record without a slot alone", async () => {
    const none = await store("Пишет на Codex", "none");
    const undefinedSlot = await store("Пробует Claude Code", "undefined");
    const plain = await store("Любит мутационное тестирование", null);

    await runMigration();

    expect((await stateOf(none)).attribute).toBeNull();
    expect((await stateOf(undefinedSlot)).attribute).toBeNull();
    // The text did not change, and the model reads updatedAt as a change of the text.
    const touched = await database().query(
      "SELECT 1 FROM memory_items_all WHERE id = ANY($1::uuid[]) AND updated_at <> created_at",
      [[none, undefinedSlot]],
    );
    expect(touched.rowCount).toBe(0);
    expect(await stateOf(plain)).toEqual({ attribute: null, claim_status: "active", superseded_by: null });
  });

  it("keeps the history of a real slot and a correction as they were", async () => {
    const oldJob = await store("Работает в «Ладоге»", "место работы");
    const newJob = await store("Работает в «Север-Софте»", "место работы");
    await retire(oldJob, newJob, "temporal_update", { attribute: "место работы" });
    const typo = await store("Фанат TTD", "null");
    const fixed = await store("Фанат TDD", "null");
    // A correction writes no slot metadata; it carries one here so only the relation type protects it.
    await retire(typo, fixed, "correction", { attribute: "null" });

    await runMigration();

    expect(await stateOf(oldJob))
      .toEqual({ attribute: "место работы", claim_status: "superseded", superseded_by: newJob });
    expect(await relationsOf(oldJob)).toEqual(["temporal_update"]);
    expect(await stateOf(typo)).toEqual({ attribute: null, claim_status: "superseded", superseded_by: fixed });
    expect(await relationsOf(typo)).toEqual(["correction"]);
  });

  it("leaves a record the person deleted deleted, even when a placeholder slot once retired it", async () => {
    const deleted = await store("Пишет тесты после кода", "null");
    const current = await store("Пишет на Codex", "null");
    await retire(deleted, current, "temporal_update", { attribute: "null" });
    // Deleting retracts the record and drops its pointer; the relation is what may remain.
    await database().query(
      "UPDATE memory_items_all SET claim_status = 'retracted', superseded_by = NULL, deleted_at = now() WHERE id = $1",
      [deleted],
    );

    await runMigration();

    const row = await database().query<{ claim_status: string; deleted: boolean }>(
      "SELECT claim_status, deleted_at IS NOT NULL AS deleted FROM memory_items_all WHERE id = $1",
      [deleted],
    );
    expect(row.rows[0]).toEqual({ claim_status: "retracted", deleted: true });
    expect(await relationsOf(deleted)).toEqual([]);
  });
});
