/**
 * The only state the memory review could not be brought out of.
 *
 * Constructs covered:
 * - A head that failed after writing part of its memories can be skipped by an operator.
 * - What it already wrote stays: the skip moves the queue, it does not erase memory.
 * - The audit record says what was kept and why, in the operator's own words.
 * - A batch the narrow commands do cover is refused here, so they stay narrow.
 * - A repeat of the same skip is the same answer, not a second cursor move.
 *
 * If the review fell over after writing some of its memories, the lane stopped and neither
 * operator command would take it: `skip-unbound` only accepts one diagnostic code, and
 * `recover-model` refuses by construction as soon as any memory was written. The group's memory
 * then stopped filling until somebody edited the production database by hand.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { skipPartialMemoryReviewBatch } from "./memory-review-admin.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

const PARTIAL = "AGENT_MEMORY_REVIEW_PARTIAL_RESULT";
const SOURCE_MISSING = "AGENT_MEMORY_REVIEW_SOURCE_BINDING_MISSING";

describeWithDatabase("operator skip of a partially written review", () => {
  let batchId: string;
  let conversationId: string;
  let familyId: string;
  let groupId: string;
  let laneId: string;
  let writtenClaimId: string;

  async function seed(diagnosticCode: string): Promise<void> {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Пробка') RETURNING id",
    );
    familyId = family.rows[0]!.id;
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, 'stuck-chat', 'Рабочий чат', 'external', 'all') RETURNING id`,
      [familyId],
    );
    groupId = group.rows[0]!.id;
    const conversation = await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE telegram_group_id = $1", [groupId],
    );
    conversationId = conversation.rows[0]!.id;
    const lane = await database().query<{ id: string }>(
      `INSERT INTO memory_review_lanes (conversation_id, message_thread_id,
                                        processed_through_sequence)
       VALUES ($1, NULL, 0) RETURNING id`,
      [conversationId],
    );
    laneId = lane.rows[0]!.id;
    const batch = await database().query<{ id: string }>(
      `INSERT INTO memory_review_batches
         (lane_id, conversation_id, predecessor_sequence, from_sequence,
          through_sequence, source_count, status, diagnostic_code, completed_at,
          eve_session_id, eve_turn_id, batch_kind, recovery_protocol)
       VALUES ($1, $2, 0, 1, 50, 50, 'failed', $3, now(), 'wrun_stuck', 'turn_0',
               'background', 1)
       RETURNING id`,
      [laneId, conversationId, diagnosticCode],
    );
    batchId = batch.rows[0]!.id;
    // A review write is recognized by its source string, the same way the recovery command finds it.
    const written = await database().query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, group_id, author_telegram_user_id, scope, kind, content, source,
          confirmation, sensitivity, operation_key)
       VALUES ($1, $2, 'stuck-author', 'group', 'fact', 'Успели записать до падения',
               'eve:wrun_stuck:turn_0', 'model_high', 'normal', 'stuck-write')
       RETURNING id`,
      [familyId, groupId],
    );
    writtenClaimId = written.rows[0]!.id;
  }

  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_items_all, memory_review_batches, memory_review_lanes, telegram_group_messages, application_conversations, telegram_groups, family_memberships, users, families CASCADE",
    );
  });

  afterAll(async () => closeDatabase());

  it("moves the queue past the batch and keeps what it had written", async () => {
    await seed(PARTIAL);

    const result = await skipPartialMemoryReviewBatch({
      batchId, reason: "Разобрано вручную, записанное оставлено",
    });

    expect(result).toMatchObject({ keptMemories: 1, outcome: "skipped", processedThroughSequence: "50" });
    await expect(database().query(
      "SELECT claim_status::text AS status FROM memory_items WHERE id = $1", [writtenClaimId],
    )).resolves.toMatchObject({ rows: [{ status: "active" }] });
  });

  it("writes down what was kept and why", async () => {
    await seed(PARTIAL);

    await skipPartialMemoryReviewBatch({ batchId, reason: "Разобрано вручную" });

    const audit = await database().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
       WHERE subject_id = $1 AND event_type = 'memory_review.operator_skipped_partial'`,
      [batchId],
    );
    expect(audit.rows[0]!.metadata).toMatchObject({
      keptMemories: 1,
      originalDiagnosticCode: PARTIAL,
      reason: "Разобрано вручную",
    });
  });

  it("refuses a batch the narrow command already covers", async () => {
    // Keeping the narrow commands narrow is the point: each of them proves its own case is safe.
    await seed(SOURCE_MISSING);
    await database().query("DELETE FROM memory_items_all WHERE id = $1", [writtenClaimId]);

    await expect(skipPartialMemoryReviewBatch({ batchId, reason: "Не тот случай" }))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_REVIEW_PARTIAL_SKIP_NOT_APPLICABLE" });
  });

  it("answers a repeated skip without moving the queue again", async () => {
    await seed(PARTIAL);
    await skipPartialMemoryReviewBatch({ batchId, reason: "Разобрано вручную" });

    const again = await skipPartialMemoryReviewBatch({ batchId, reason: "Разобрано вручную" });

    expect(again.outcome).toBe("replayed");
    await expect(database().query(
      `SELECT count(*)::integer AS events FROM audit_events
       WHERE subject_id = $1 AND event_type = 'memory_review.operator_skipped_partial'`,
      [batchId],
    )).resolves.toMatchObject({ rows: [{ events: 1 }] });
  });

  it("refuses a batch that is not the head of its lane", async () => {
    await seed(PARTIAL);
    await database().query(
      "UPDATE memory_review_lanes SET processed_through_sequence = 90 WHERE id = $1", [laneId],
    );

    await expect(skipPartialMemoryReviewBatch({ batchId, reason: "Не голова" }))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_REVIEW_PARTIAL_SKIP_STATE_INVALID" });
  });
});
