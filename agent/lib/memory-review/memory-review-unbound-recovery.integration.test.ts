/** Legacy unstarted turns must replay their exact sources without discarding completed successors. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryRepository } from "../memory-repository.js";
import { memoryTurnSourceRepository } from "../memory-turn-source-repository.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { memoryReviewSessionRepository } from "./memory-review-session-repository.js";
import { insertReviewSession, insertReviewUserMessage } from "./memory-review.integration-fixtures.js";
import { readMemoryReviewLaneHealth, recoverUnstartedReviewBatches } from "./memory-review-lane-recovery.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe : describe.skip;
const LEGACY_CODE = "AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS";

async function incident() {
  const fixture = await createMainAgentMemoryFixture();
  const session = await insertReviewSession(fixture.familyId, fixture.groupId, "unbound-recovery");
  const head = (await memoryReviewRepository.prepareInteractiveTurn({
    applicationSessionId: session, groupId: fixture.groupId, timelineEntryId: fixture.timelineEntryId,
  }))!;
  const nextSource = await insertReviewUserMessage({ ...fixture, sequence: 2 });
  const next = (await memoryReviewRepository.prepareInteractiveTurn({
    applicationSessionId: session, groupId: fixture.groupId, timelineEntryId: nextSource.id,
  }))!;
  await database().query(
    `UPDATE memory_review_batches SET status = 'completed', completed_at = now()
      WHERE id = $1`, [next.batchId],
  );
  await database().query(
    "DELETE FROM memory_review_batch_sources WHERE batch_id = $1", [next.batchId],
  );
  await database().query(
    `UPDATE memory_review_batches SET status = 'ambiguous', diagnostic_code = $2,
       completed_at = now() WHERE id = $1`, [head.batchId, LEGACY_CODE],
  );
  await database().query(
    "UPDATE conversation_sessions SET retired_at = now() WHERE id = $1", [session],
  );
  return { fixture, head, next, session };
}

function claim() {
  return memoryReviewDispatchRepository.claimPending({
    leaseMilliseconds: 60_000, limit: 10, now: new Date(),
  });
}

describeWithDatabase("unbound interactive memory-review recovery", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(closeDatabase);

  it("replays the one missing source, preserves successors and advances through them on completion", async () => {
    const { fixture, head, next, session } = await incident();
    const [recovered] = await claim();
    expect(recovered).toMatchObject({ batchId: head.batchId, sourceCount: 1,
      sourceEntryIds: [fixture.timelineEntryId] });
    expect(await claim()).toEqual([]);
    await expect(database().query(
      `SELECT batch_kind::text, recovery_attempts, last_recovery_diagnostic_code,
         application_session_id FROM memory_review_batches WHERE id = $1`, [head.batchId],
    )).resolves.toMatchObject({ rows: [{ batch_kind: "background", recovery_attempts: 1,
      last_recovery_diagnostic_code: LEGACY_CODE, application_session_id: null }] });
    await expect(database().query(
      "SELECT status::text, predecessor_sequence::text FROM memory_review_batches WHERE id = $1",
      [next.batchId],
    )).resolves.toMatchObject({ rows: [{ status: "completed", predecessor_sequence: "1" }] });
    await expect(database().query(
      "SELECT kind::text, retired_at IS NOT NULL AS retired FROM conversation_sessions WHERE id = $1",
      [session],
    )).resolves.toMatchObject({ rows: [{ kind: "canonical", retired: true }] });
    expect(await memoryReviewRepository.getLaneCursor({
      conversationId: fixture.conversationId, messageThreadId: null,
    })).toBe("0");

    const prepared = await memoryReviewSessionRepository.prepare(recovered!, new Date());
    await memoryReviewDispatchRepository.markDispatchStarted(recovered!, prepared.id);
    await memoryReviewRepository.bindEveTurn({ applicationSessionId: prepared.id,
      batchId: head.batchId, eveSessionId: "eve-recovered", eveTurnId: "turn-recovered" });
    await memoryTurnSourceRepository.bindReview({ applicationSessionId: prepared.id,
      conversationId: fixture.conversationId,
      eveSessionId: "eve-recovered", eveTurnId: "turn-recovered",
      invokingActorId: "agent-memory-author", invokingActorKind: "telegram_user",
      memoryReviewBatchId: head.batchId, sourceEntryIds: head.sourceEntryIds });
    expect(await memoryReviewRepository.completeBatch({ batchId: head.batchId,
      completedAt: new Date(), eveSessionId: "eve-recovered", eveTurnId: "turn-recovered" }))
      .toBe("recorded");
    expect(await memoryReviewRepository.getLaneCursor({
      conversationId: fixture.conversationId, messageThreadId: null,
    })).toBe("2");
    expect(await claim()).toEqual([]);
    await expect(database().query(
      "SELECT count(*)::integer AS n FROM audit_events WHERE event_type = 'memory_review.recovered' AND subject_id = $1",
      [head.batchId],
    )).resolves.toMatchObject({ rows: [{ n: 1 }] });
  });

  it.each(["bound", "source_set", "live_session", "missing_source", "changed_source", "other_failure", "already_recovered"])(
    "does not replay an unsafe or unrelated batch: %s", async (reason) => {
      const { fixture, head, session } = await incident();
      if (reason === "bound") await database().query(
        "UPDATE memory_review_batches SET eve_session_id = 'old-eve', eve_turn_id = 'old-turn' WHERE id = $1", [head.batchId]);
      if (reason === "source_set") await database().query(
        `INSERT INTO memory_turn_source_sets
          (eve_session_id, eve_turn_id, application_session_id, conversation_id,
           current_timeline_entry_id, invoking_actor_kind, invoking_actor_id, binding_hash, memory_review_batch_id)
         VALUES ('old-eve', 'old-turn', $1, $2, $3, 'telegram_user', 'agent-memory-author', $4, $5)`,
        [session, fixture.conversationId, fixture.timelineEntryId, "a".repeat(64), head.batchId]);
      if (reason === "live_session") await database().query(
        "UPDATE conversation_sessions SET retired_at = NULL WHERE id = $1", [session]);
      if (reason === "missing_source") await database().query(
        "DELETE FROM memory_review_batch_sources WHERE batch_id = $1", [head.batchId]);
      if (reason === "changed_source") await database().query(
        "UPDATE memory_review_batch_sources SET timeline_sequence = 9 WHERE batch_id = $1", [head.batchId]);
      if (reason === "other_failure") await database().query(
        "UPDATE memory_review_batches SET diagnostic_code = 'MODEL_CALL_FAILED' WHERE id = $1", [head.batchId]);
      if (reason === "already_recovered") await database().query(
        `UPDATE memory_review_batches SET recovery_attempts = 1,
           last_recovery_diagnostic_code = $2, last_recovered_at = now() WHERE id = $1`,
        [head.batchId, LEGACY_CODE]);
      expect(await claim()).toEqual([]);
      expect(await memoryReviewRepository.getLaneCursor({
        conversationId: fixture.conversationId, messageThreadId: null,
      })).toBe("0");
    },
  );

  it("does not replay a source that already produced a fact, even if the batch binding is missing", async () => {
    const { fixture } = await incident();
    await memoryRepository.create(fixture.auth, {
      content: "Анна готовится к марафону", kind: "fact", scope: "family",
      confirmation: "model_high", sensitivity: "normal", source: "eve:other:turn",
      operationKey: "other-memory-write", provenance: { sessionId: "other", turnId: "turn" },
      explicitSource: { conversationId: fixture.conversationId,
        timelineEntryId: fixture.timelineEntryId, subject: { kind: "current_author" } },
    });
    expect(await claim()).toEqual([]);
  });

  it("reports a blocked lane and creates only one owner alert without replaying it", async () => {
    const { head } = await incident();
    await database().query(
      "UPDATE memory_review_batches SET diagnostic_code = 'MODEL_CALL_FAILED' WHERE id = $1", [head.batchId]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await claim();
    await claim();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_MEMORY_REVIEW_LANE_BLOCKED"));
    await expect(database().query(
      "SELECT count(*)::integer AS n FROM memory_review_owner_alerts WHERE batch_id = $1", [head.batchId],
    )).resolves.toMatchObject({ rows: [{ n: 1 }] });
  });

  it("gives concurrent dispatchers only one lease for the recovered source", async () => {
    const { head } = await incident();
    const results = await Promise.all([claim(), claim()]);
    expect(results.flat().map((batch) => batch.batchId)).toEqual([head.batchId]);
  });

  it("keeps ordinary short background batches forbidden by the database", async () => {
    const { head } = await incident();
    await expect(database().query(
      `UPDATE memory_review_batches SET batch_kind = 'background', status = 'pending',
         completed_at = NULL, application_session_id = NULL WHERE id = $1`, [head.batchId],
    )).rejects.toThrow("memory_review_batches_background_source_count");
  });

  it("allows an alert foreign-key check while recovery waits for another dispatcher's lane lock", async () => {
    const { head } = await incident();
    const recovering = await database().connect();
    const monitoring = await database().connect();
    let recovery: Promise<unknown> | undefined;
    try {
      await recovering.query("BEGIN");
      await monitoring.query("BEGIN");
      await monitoring.query("SET LOCAL lock_timeout = '500ms'");
      const pid = (await recovering.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await monitoring.query(
        `SELECT 1 FROM memory_review_lanes WHERE id = (
           SELECT lane_id FROM memory_review_batches WHERE id = $1) FOR UPDATE`, [head.batchId],
      );
      recovery = recoverUnstartedReviewBatches(recovering, new Date()).then(() => null, (error: unknown) => error);
      await vi.waitFor(async () => {
        const locks = await database().query<{ waiting: boolean }>(
          "SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting", [pid],
        );
        expect(locks.rows[0]!.waiting).toBe(true);
      }, { timeout: 2_000, interval: 20 });
      // Alert insertion takes KEY SHARE on the batch for its FK. It must not wait for the
      // recovery transaction, which already waits for this transaction's lane lock.
      await expect(readMemoryReviewLaneHealth(monitoring)).resolves.toHaveLength(1);
    } finally {
      await monitoring.query("ROLLBACK");
      const recoveryError = await recovery;
      await recovering.query("ROLLBACK");
      monitoring.release();
      recovering.release();
      if (recoveryError) throw recoveryError;
    }
  });

  it("takes older lanes before the recovered lane, without an inverted two-lane wait", async () => {
    const { fixture, head } = await incident();
    const older = (await database().query<{ id: string }>(
      `INSERT INTO memory_review_lanes (conversation_id, message_thread_id, processed_through_sequence, created_at)
       VALUES ($1, 42, 0, '2020-01-01') RETURNING id`, [fixture.conversationId],
    )).rows[0]!.id;
    const other = await database().connect();
    let pending: Promise<unknown> | undefined;
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
      const failure = await pending;
      if (failure) throw failure;
    }
  });

  it("defers an alert for a batch held by a terminal handler rather than waiting with its lane locked", async () => {
    const { head } = await incident();
    await database().query("UPDATE memory_review_batches SET diagnostic_code = 'MODEL_CALL_FAILED' WHERE id = $1", [head.batchId]);
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
