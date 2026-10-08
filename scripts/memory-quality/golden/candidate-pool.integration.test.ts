/**
 * Rewinding a database copy to the moment a question was asked.
 *
 * Constructs covered:
 * - A record younger than the question is hidden, deleted since or not; one created before it stays.
 * - A record deleted after the question is back in the status it had then — active, or superseded
 *   by its successor; one deleted before the question stays deleted.
 * - A version whose successor is younger than the question is current again; one superseded
 *   before it stays superseded.
 * - A rewind to an older moment hides what was created in between, so the copy walked from the
 *   newest question back is right at every step.
 * - The pool of a question neither offers nor gates a record younger than the question.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../../../agent/lib/database.js";
import type { MemoryAuthorization } from "../../../agent/lib/memory-context.js";
import { MEMORY_EMBEDDING_DIMENSIONS } from "../../../agent/lib/memory-config.js";
import { prepareMemoryQuery } from "../../../agent/lib/memory-query-preparation.js";
import { createMemoryFamilyFixture } from "../../../agent/lib/memory-repository.integration-fixtures.js";
import { collectTurnCandidates, rewindCopyTo } from "./candidate-pool.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

const QUESTION_AT = "2026-10-05T12:00:00.000Z";
const OLDER_QUESTION_AT = "2026-10-04T06:00:00.000Z";

interface StoredRecord {
  id: string;
  ref: string;
}

describeWithDatabase("rewindCopyTo", () => {
  let owner: MemoryAuthorization;
  const records: Record<string, StoredRecord> = {};

  async function record(key: string, createdAt: string, content = `Запись ${key}`): Promise<StoredRecord> {
    const inserted = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, source, confirmation, sensitivity, operation_key, embedding_status)
       VALUES ($1, $2, $2, $3, 'personal', 'fact', $4, 'test:golden', 'user_confirmed', 'normal', $5, 'indexed')
       RETURNING id`,
      [owner.familyId, owner.userId, owner.telegramUserId, content, `golden-${key}`],
    );
    const id = inserted.rows[0]!.id;
    await database().query("UPDATE memory_items_all SET created_at = $2 WHERE id = $1", [id, createdAt]);
    const ref = await database().query<{ memory_ref: string }>(
      "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1", [id],
    );
    records[key] = { id, ref: ref.rows[0]!.memory_ref };
    return records[key]!;
  }

  async function state(key: string): Promise<{ claim_status: string; deleted: boolean }> {
    const row = await database().query<{ claim_status: string; deleted: boolean }>(
      "SELECT claim_status, deleted_at IS NOT NULL AS deleted FROM memory_items_all WHERE id = $1",
      [records[key]!.id],
    );
    return row.rows[0]!;
  }

  async function successorOf(key: string): Promise<string | null> {
    const row = await database().query<{ superseded_by: string | null }>(
      "SELECT superseded_by FROM memory_items_all WHERE id = $1", [records[key]!.id],
    );
    return row.rows[0]!.superseded_by;
  }

  async function deleteLater(item: StoredRecord, at: string): Promise<void> {
    // As the product deletes: retracted, its own supersession released, and hidden.
    await database().query(
      "UPDATE memory_items_all SET deleted_at = $2, claim_status = 'retracted', superseded_by = NULL WHERE id = $1",
      [item.id, at],
    );
  }

  beforeAll(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, family_memberships, users, families CASCADE",
    );
    owner = (await createMemoryFamilyFixture("golden")).owner;

    await record("young", "2026-10-05T13:00:00.000Z");
    await record("old", "2026-10-03T09:00:00.000Z");
    await record("createdBetween", "2026-10-04T10:00:00.000Z");

    const deletedLater = await record("deletedLater", "2026-10-03T09:00:00.000Z");
    const deletedEarlier = await record("deletedEarlier", "2026-10-03T09:00:00.000Z");
    await database().query(
      "UPDATE memory_items_all SET deleted_at = $2, claim_status = 'retracted' WHERE id = $1",
      [deletedLater.id, "2026-10-05T14:00:00.000Z"],
    );
    await database().query(
      "UPDATE memory_items_all SET deleted_at = $2, claim_status = 'retracted' WHERE id = $1",
      [deletedEarlier.id, "2026-10-04T00:00:00.000Z"],
    );

    const replacedLater = await record("replacedLater", "2026-10-03T09:00:00.000Z");
    const lateSuccessor = await record("lateSuccessor", "2026-10-05T15:00:00.000Z");
    const replacedEarlier = await record("replacedEarlier", "2026-10-03T09:00:00.000Z");
    const earlySuccessor = await record("earlySuccessor", "2026-10-03T10:00:00.000Z");
    for (const [previous, successor] of [[replacedLater, lateSuccessor], [replacedEarlier, earlySuccessor]] as const) {
      await database().query(
        "UPDATE memory_items_all SET claim_status = 'superseded', superseded_by = $2 WHERE id = $1",
        [previous.id, successor.id],
      );
    }

    const createdAndDeletedLater = await record("createdAndDeletedLater", "2026-10-05T13:30:00.000Z");
    await deleteLater(createdAndDeletedLater, "2026-10-05T20:00:00.000Z");

    // Corrected before the question, then the old version deleted after it.
    const correctedThenDeleted = await record("correctedThenDeleted", "2026-10-03T09:00:00.000Z");
    const correction = await record("correction", "2026-10-04T09:00:00.000Z");
    await database().query(
      `INSERT INTO claim_relations
         (source_claim_id, target_claim_id, family_id, scope, scope_partition_key, relation_type, detection_method)
       SELECT id, $2, family_id, scope, scope_partition_key, 'correction', 'user_explicit'
       FROM memory_items_all WHERE id = $1`,
      [correctedThenDeleted.id, correction.id],
    );
    await deleteLater(correctedThenDeleted, "2026-10-05T19:00:00.000Z");

    await record("backupOnDisk", "2026-10-03T09:00:00.000Z", "Бэкап лежит на внешнем диске в кладовке");
    await record("backupInCloud", "2026-10-05T18:00:00.000Z", "Бэкап лежит в облаке у провайдера");

    await rewindCopyTo(QUESTION_AT);
  }, 120_000);

  afterAll(async () => closeDatabase());

  it("hides what did not exist yet and keeps what did", async () => {
    expect(await state("young")).toEqual({ claim_status: "active", deleted: true });
    expect(await state("createdAndDeletedLater")).toMatchObject({ deleted: true });
    expect(await state("old")).toEqual({ claim_status: "active", deleted: false });
  });

  it("brings back a record deleted after the question, not one deleted before it", async () => {
    expect(await state("deletedLater")).toEqual({ claim_status: "active", deleted: false });
    expect(await state("deletedEarlier")).toEqual({ claim_status: "retracted", deleted: true });
  });

  it("brings a record deleted later back in the status it had at the question", async () => {
    expect(await state("correctedThenDeleted")).toEqual({ claim_status: "superseded", deleted: false });
    expect(await successorOf("correctedThenDeleted")).toBe(records.correction!.id);
  });

  it("makes a version current again when its successor is younger than the question", async () => {
    expect(await state("replacedLater")).toEqual({ claim_status: "active", deleted: false });
    expect(await state("lateSuccessor")).toMatchObject({ deleted: true });
    expect(await state("replacedEarlier")).toEqual({ claim_status: "superseded", deleted: false });
  });

  it("neither offers nor gates a record younger than the question", async () => {
    const raw = "где лежит бэкап";
    const unit = [1, ...Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS - 1 }, () => 0)];
    const turn = await collectTurnCandidates({
      authorization: owner, kind: "question", message: raw, query: prepareMemoryQuery(raw),
      sessionId: "session-golden", startedAt: QUESTION_AT, turnId: "turn-golden",
    }, [unit], null);

    expect(turn.offered.map((item) => item.memoryRef)).toContain(records.backupOnDisk!.ref);
    expect(turn.offered.map((item) => item.memoryRef)).not.toContain(records.backupInCloud!.ref);
    expect(turn.gated).not.toContain(records.backupInCloud!.ref);
  });

  it("hides on an older rewind what was created between the two questions", async () => {
    expect(await state("createdBetween")).toEqual({ claim_status: "active", deleted: false });

    await rewindCopyTo(OLDER_QUESTION_AT);

    expect(await state("createdBetween")).toEqual({ claim_status: "active", deleted: true });
    expect(await state("deletedLater")).toEqual({ claim_status: "active", deleted: false });
    expect(await state("old")).toEqual({ claim_status: "active", deleted: false });
    // Its correction did not exist yet either: the version was current.
    expect(await state("correction")).toMatchObject({ deleted: true });
    expect(await state("correctedThenDeleted")).toEqual({ claim_status: "active", deleted: false });
  });
});
