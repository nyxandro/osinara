/**
 * Lane health of the group memory review.
 *
 * Constructs covered:
 * - A stopped lane head is reported once to the owner and is not replayed.
 * - The monitor defers an alert for a batch a terminal handler holds instead of waiting with the
 *   lane locked.
 * - A claim takes lanes in one global order, so two dispatchers never wait on each other.
 * - A short background batch stays forbidden by the database.
 *
 * The stopped head is an interactive batch as the chat-turn path left it before #569: such rows
 * stay in the table, and their recovery now lives in migration 158.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { insertHistoricalInteractiveBatch, insertReviewSession } from "./memory-review.integration-fixtures.js";
import { readMemoryReviewLaneHealth } from "./memory-review-lane-recovery.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe : describe.skip;

async function stoppedHead() {
  const fixture = await createMainAgentMemoryFixture();
  const session = await insertReviewSession(fixture.familyId, fixture.groupId, "lane-health");
  const head = await insertHistoricalInteractiveBatch({
    applicationSessionId: session, groupId: fixture.groupId, timelineEntryId: fixture.timelineEntryId,
  });
  await database().query(
    `UPDATE memory_review_batches SET status = 'ambiguous', diagnostic_code = 'MODEL_CALL_FAILED',
       completed_at = now() WHERE id = $1`, [head.batchId],
  );
  return { fixture, head };
}

function claim() {
  return memoryReviewDispatchRepository.claimPending({
    leaseMilliseconds: 60_000, limit: 10, now: new Date(),
  });
}

describeWithDatabase("memory-review lane health", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(closeDatabase);

  it("reports a blocked lane and creates only one owner alert without replaying it", async () => {
    const { head } = await stoppedHead();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await claim()).toEqual([]);
    expect(await claim()).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_MEMORY_REVIEW_LANE_BLOCKED"));
    await expect(database().query(
      "SELECT count(*)::integer AS n FROM memory_review_owner_alerts WHERE batch_id = $1", [head.batchId],
    )).resolves.toMatchObject({ rows: [{ n: 1 }] });
  });

  it("keeps ordinary short background batches forbidden by the database", async () => {
    const { head } = await stoppedHead();
    await expect(database().query(
      `UPDATE memory_review_batches SET batch_kind = 'background', status = 'pending',
         completed_at = NULL, application_session_id = NULL WHERE id = $1`, [head.batchId],
    )).rejects.toThrow("memory_review_batches_background_source_count");
  });

  it("takes older lanes before a later one, without an inverted two-lane wait", async () => {
    const { fixture, head } = await stoppedHead();
    const older = (await database().query<{ id: string }>(
      `INSERT INTO memory_review_lanes (conversation_id, message_thread_id, processed_through_sequence, created_at)
       VALUES ($1, 42, 0, '2020-01-01') RETURNING id`, [fixture.conversationId],
    )).rows[0]!.id;
    const other = await database().connect();
    let pending: Promise<unknown> | undefined;
    let failure: unknown;
    try {
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '500ms'");
      const pid = (await other.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await other.query("SELECT 1 FROM memory_review_lanes WHERE id = $1 FOR UPDATE", [older]);
      pending = claim().then(() => null, (error: unknown) => error);
      await vi.waitFor(async () => {
        const result = await database().query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS waiting`, [pid],
        );
        expect(result.rows[0]!.waiting).toBe(true);
      }, { timeout: 2_000, interval: 20 });
      // A dispatcher waiting for the older lane must not already own a later one.
      await expect(other.query(
        `SELECT 1 FROM memory_review_lanes WHERE id = (
          SELECT lane_id FROM memory_review_batches WHERE id = $1) FOR UPDATE`, [head.batchId],
      )).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await other.query("ROLLBACK");
      other.release();
      failure = await pending;
    }
    if (failure) throw failure;
  });

  it("defers an alert for a batch held by a terminal handler rather than waiting with its lane locked", async () => {
    const { head } = await stoppedHead();
    const handler = await database().connect();
    const monitor = await database().connect();
    try {
      await handler.query("BEGIN");
      await monitor.query("BEGIN");
      await monitor.query("SET LOCAL lock_timeout = '500ms'");
      await handler.query("SELECT 1 FROM memory_review_batches WHERE id = $1 FOR UPDATE", [head.batchId]);
      await monitor.query(
        `SELECT 1 FROM memory_review_lanes WHERE id = (
          SELECT lane_id FROM memory_review_batches WHERE id = $1) FOR UPDATE`, [head.batchId],
      );
      await expect(readMemoryReviewLaneHealth(monitor)).resolves.toHaveLength(1);
      await expect(monitor.query("SELECT count(*)::integer AS n FROM memory_review_owner_alerts"))
        .resolves.toMatchObject({ rows: [{ n: 0 }] });
    } finally {
      await monitor.query("ROLLBACK");
      await handler.query("ROLLBACK");
      monitor.release();
      handler.release();
    }
    await claim();
    await expect(database().query("SELECT count(*)::integer AS n FROM memory_review_owner_alerts"))
      .resolves.toMatchObject({ rows: [{ n: 1 }] });
  });
});
