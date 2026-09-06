/**
 * Migration 092 stuck-lane healing integration tests.
 *
 * Constructs covered:
 * - A failed or ambiguous head with a completed successor chain becomes skipped, loses its
 *   sources, and the lane cursor moves to the end of the chain.
 * - A head without a successor is left alone: a live pass releases or keeps it by provenance.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { insertReviewUserMessage } from "./memory-review.integration-fixtures.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

async function insertBatch(input: {
  conversationId: string;
  laneId: string;
  predecessor: number;
  sourceIds: readonly string[];
  status: "ambiguous" | "completed" | "failed";
  through: number;
}): Promise<string> {
  const batch = await database().query<{ id: string }>(
    `INSERT INTO memory_review_batches
       (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
        through_sequence, source_count, diagnostic_code, started_at, completed_at)
     VALUES ($1, $2, 'interactive', $3::memory_review_batch_status, $4::bigint, $4::bigint + 1, $5::bigint, $6::integer, $7::text, now(), now())
     RETURNING id`,
    [input.laneId, input.conversationId, input.status, input.predecessor, input.through,
      Math.max(1, input.sourceIds.length),
      input.status === "completed" ? null : "AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS"],
  );
  for (const [index, id] of input.sourceIds.entries()) {
    await database().query(
      `INSERT INTO memory_review_batch_sources (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
       VALUES ($1, $2, $3, $4)`,
      [batch.rows[0]!.id, input.conversationId, id, input.predecessor + 1 + index],
    );
  }
  return batch.rows[0]!.id;
}

describeWithDatabase("migration 092: heal stuck memory review lanes", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("skips a dead head with finished successors and moves the cursor; leaves a lone head alone", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const messages: string[] = [];
    for (let sequence = 2; sequence <= 30; sequence += 1) {
      messages.push((await insertReviewUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId, sequence,
      })).id);
    }
    const lane = (await database().query<{ id: string }>(
      `INSERT INTO memory_review_lanes (conversation_id, message_thread_id, processed_through_sequence)
       VALUES ($1, NULL, 5) RETURNING id`,
      [fixture.conversationId],
    )).rows[0]!.id;
    // Ft86 on 3 September: ambiguous head @5 (message 6), completed @6..20 and @20..30 behind it.
    const head = await insertBatch({
      conversationId: fixture.conversationId, laneId: lane, predecessor: 5,
      sourceIds: [messages[4]!], status: "ambiguous", through: 6,
    });
    await insertBatch({
      conversationId: fixture.conversationId, laneId: lane, predecessor: 6, sourceIds: [], status: "completed", through: 20,
    });
    await insertBatch({
      conversationId: fixture.conversationId, laneId: lane, predecessor: 20, sourceIds: [], status: "completed", through: 30,
    });
    // A second lane (forum topic) whose failed head has nothing behind it stays as it is.
    const lonely = (await database().query<{ id: string }>(
      `INSERT INTO memory_review_lanes (conversation_id, message_thread_id, processed_through_sequence)
       VALUES ($1, 7, 2) RETURNING id`,
      [fixture.conversationId],
    )).rows[0]!.id;
    const lonelyHead = await insertBatch({
      conversationId: fixture.conversationId, laneId: lonely, predecessor: 2, sourceIds: [], status: "failed", through: 3,
    });

    await database().query(await readFile(resolve("migrations", "092_memory_review_heal_stuck_lanes.sql"), "utf8"));

    await expect(database().query(
      "SELECT status::text, diagnostic_code FROM memory_review_batches WHERE id = $1", [head],
    )).resolves.toMatchObject({ rows: [{ diagnostic_code: "AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS", status: "skipped" }] });
    await expect(database().query(
      "SELECT count(*)::integer AS sources FROM memory_review_batch_sources WHERE batch_id = $1", [head],
    )).resolves.toMatchObject({ rows: [{ sources: 0 }] });
    await expect(database().query(
      "SELECT processed_through_sequence::text AS cursor FROM memory_review_lanes WHERE id = $1", [lane],
    )).resolves.toMatchObject({ rows: [{ cursor: "30" }] });
    await expect(database().query(
      "SELECT status::text FROM memory_review_batches WHERE id = $1", [lonelyHead],
    )).resolves.toMatchObject({ rows: [{ status: "failed" }] });
    await expect(database().query(
      "SELECT processed_through_sequence::text AS cursor FROM memory_review_lanes WHERE id = $1", [lonely],
    )).resolves.toMatchObject({ rows: [{ cursor: "2" }] });
  });
});
