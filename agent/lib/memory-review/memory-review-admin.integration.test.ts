/** An explicit operator skip must unblock the chain without replaying facts or losing successors. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryRepository } from "../memory-repository.js";
import { memoryTurnSourceRepository } from "../memory-turn-source-repository.js";
import { inspectMemoryReviewLanes, skipUnboundMemoryReviewBatch } from "./memory-review-admin.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { memoryReviewSessionRepository } from "./memory-review-session-repository.js";
import { insertReviewUserMessage } from "./memory-review.integration-fixtures.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const SOURCE_MISSING = "AGENT_MEMORY_REVIEW_SOURCE_BINDING_MISSING";
const claim = () => memoryReviewDispatchRepository.claimPending({
  leaseMilliseconds: 60_000, limit: 10, now: new Date(),
});

async function incident() {
  const fixture = await createMainAgentMemoryFixture();
  for (let sequence = 2; sequence <= 100; sequence++) {
    const source = await insertReviewUserMessage({ ...fixture, sequence });
    if (sequence === 6 || sequence === 56) await database().query(
      `UPDATE telegram_group_messages SET actor_kind = 'telegram_bot',
        actor_id = 'telegram-bot:123456', telegram_user_id = '123456', sender_is_bot = true
        WHERE id = $1`, [source.id],
    );
    await memoryReviewRepository.observePassiveMessage({ groupId: fixture.groupId, timelineEntryId: source.id });
  }
  const [head] = await claim();
  const prepared = await memoryReviewSessionRepository.prepare(head!, new Date());
  await memoryReviewDispatchRepository.markDispatchStarted(head!, prepared.id);
  await memoryReviewRepository.bindEveTurn({ applicationSessionId: prepared.id,
    batchId: head!.batchId, eveSessionId: "eve-broken", eveTurnId: "turn-broken" });
  // Persisted incident: the old 49-human/1-bot source check failed before creating the source set.
  expect(await memoryReviewRepository.completeBatch({ batchId: head!.batchId,
    completedAt: new Date(), eveSessionId: "eve-broken", eveTurnId: "turn-broken" })).toBe("failed");
  return { fixture, head: head!, prepared };
}

describeWithDatabase("memory review operator recovery", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterAll(closeDatabase);

  it("shows the real blocker without mutating it, then processes the mixed successor and writes evidence", async () => {
    const { fixture, head, prepared: oldSession } = await incident();
    expect(await claim()).toEqual([]);
    expect(await inspectMemoryReviewLanes()).toMatchObject([{
      batchId: head.batchId, status: "failed", diagnosticCode: SOURCE_MISSING,
      processedThroughSequence: "0", waitingSources: 100,
    }]);
    const before = (await database().query("SELECT * FROM memory_review_batches WHERE id = $1", [head.batchId])).rows;
    await inspectMemoryReviewLanes();
    expect((await database().query("SELECT * FROM memory_review_batches WHERE id = $1", [head.batchId])).rows).toEqual(before);

    // Production already retained away the failed application session; the batch binding survives.
    await database().query("DELETE FROM conversation_sessions WHERE id = $1", [oldSession.id]);

    expect(await skipUnboundMemoryReviewBatch({ batchId: head.batchId, reason: "Владелец разрешил пропустить 50 сообщений" }))
      .toMatchObject({ outcome: "skipped", processedThroughSequence: "50" });
    const [next] = await claim();
    expect(next).toMatchObject({ sourceCount: 50, throughSequence: "100" });
    expect(next!.batchId).not.toBe(head.batchId);
    expect(next!.entries.filter((entry) => entry.actorKind === "telegram_bot")).toHaveLength(1);
    const prepared = await memoryReviewSessionRepository.prepare(next!, new Date());
    await memoryReviewDispatchRepository.markDispatchStarted(next!, prepared.id);
    await memoryReviewRepository.bindEveTurn({ applicationSessionId: prepared.id,
      batchId: next!.batchId, eveSessionId: "eve-fixed", eveTurnId: "turn-fixed" });
    await memoryTurnSourceRepository.bindReview({ applicationSessionId: prepared.id,
      conversationId: fixture.conversationId, memoryReviewBatchId: next!.batchId,
      sourceEntryIds: next!.sourceEntryIds, eveSessionId: "eve-fixed", eveTurnId: "turn-fixed",
      invokingActorId: "agent-memory-author", invokingActorKind: "telegram_user" });
    expect(await memoryTurnSourceRepository.resolve({ eveSessionId: "eve-fixed", eveTurnId: "turn-fixed", sourceSequence: "56" }))
      .toMatchObject({ isReview: true, sourceMessageId: "56" });
    await memoryRepository.create(fixture.auth, {
      content: "Анна продолжает готовиться к марафону", kind: "fact", scope: "family",
      confirmation: "model_high", sensitivity: "normal", source: "eve:eve-fixed:turn-fixed",
      operationKey: "recovery-next-fact", provenance: { sessionId: "eve-fixed", turnId: "turn-fixed" },
      explicitSource: { conversationId: fixture.conversationId,
        timelineEntryId: next!.sourceEntryIds[0]!, subject: { kind: "current_author" } },
    });
    expect(await memoryReviewRepository.completeBatch({ batchId: next!.batchId,
      completedAt: new Date(), eveSessionId: "eve-fixed", eveTurnId: "turn-fixed" })).toBe("recorded");
    expect(await memoryReviewRepository.getLaneCursor({ conversationId: fixture.conversationId, messageThreadId: null })).toBe("100");
    expect((await database().query("SELECT count(*)::integer AS n FROM claim_evidence")).rows).toEqual([{ n: 1 }]);
    expect(await claim()).toEqual([]);
  });

  it("preserves completed successors and makes concurrent/repeated skips one audited operation", async () => {
    const { fixture, head } = await incident();
    await database().query(`UPDATE memory_review_batches SET status = 'completed', completed_at = now()
      WHERE predecessor_sequence = 50`);
    const input = { batchId: head.batchId, reason: "Разрешённый пропуск" };
    const outcomes = await Promise.all([skipUnboundMemoryReviewBatch(input), skipUnboundMemoryReviewBatch(input)]);
    expect(outcomes.map((x) => x.outcome).sort()).toEqual(["replayed", "skipped"]);
    expect(await memoryReviewRepository.getLaneCursor({ conversationId: fixture.conversationId, messageThreadId: null })).toBe("100");
    expect((await database().query(`SELECT count(*)::integer AS n FROM audit_events
      WHERE event_type = 'memory_review.operator_skipped' AND subject_id = $1`, [head.batchId])).rows).toEqual([{ n: 1 }]);
    expect((await database().query("SELECT count(*)::integer AS n FROM memory_review_batch_sources WHERE batch_id = $1", [head.batchId])).rows).toEqual([{ n: 0 }]);
    expect(await memoryReviewRepository.completeBatch({ batchId: head.batchId, completedAt: new Date(),
      eveSessionId: "eve-broken", eveTurnId: "turn-broken" })).toBe("replayed");
  });

  it("also skips an isolated terminal batch instead of reissuing the approved-to-discard sources", async () => {
    const { head } = await incident();
    await database().query("DELETE FROM memory_review_batches WHERE predecessor_sequence = 50");
    expect(await skipUnboundMemoryReviewBatch({ batchId: head.batchId, reason: "Не повторять" }))
      .toMatchObject({ outcome: "skipped", processedThroughSequence: "50" });
    expect((await database().query("SELECT status::text FROM memory_review_batches WHERE id=$1", [head.batchId])).rows).toEqual([{ status: "skipped" }]);
  });

  it.each(["running", "ambiguous", "other_failure", "live_session", "source_binding", "written_memory", "retained_operation", "evidence_only", "missing_source", "changed_source", "blank_reason"])(
    "refuses unsafe or unapproved skip: %s", async (condition) => {
      const { fixture, head, prepared } = await incident();
      if (condition === "running") await database().query("UPDATE memory_review_batches SET status = 'running', completed_at = NULL WHERE id = $1", [head.batchId]);
      if (condition === "ambiguous") await database().query("UPDATE memory_review_batches SET status = 'ambiguous' WHERE id = $1", [head.batchId]);
      if (condition === "other_failure") await database().query("UPDATE memory_review_batches SET diagnostic_code = 'MODEL_CALL_FAILED' WHERE id = $1", [head.batchId]);
      if (condition === "live_session") await database().query("UPDATE conversation_sessions SET retired_at = NULL, delete_after = NULL WHERE id = $1", [prepared.id]);
      if (condition === "source_binding") await database().query(`INSERT INTO memory_turn_source_sets
        (eve_session_id,eve_turn_id,application_session_id,conversation_id,current_timeline_entry_id,
          invoking_actor_kind,invoking_actor_id,binding_hash,memory_review_batch_id)
        VALUES ('eve-broken','turn-broken',$1,$2,NULL,'telegram_user','agent-memory-author',$3,$4)`,
      [prepared.id,fixture.conversationId,"a".repeat(64),head.batchId]);
      if (condition === "missing_source") await database().query(
        "DELETE FROM memory_review_batch_sources WHERE batch_id=$1 AND timeline_sequence=6", [head.batchId]);
      if (condition === "changed_source") await database().query(
        "UPDATE telegram_group_messages SET message_thread_id=42 WHERE conversation_id=$1 AND sequence_id=6", [fixture.conversationId]);
      if (["written_memory", "retained_operation", "evidence_only"].includes(condition)) await memoryRepository.create(fixture.auth, {
        content: "Анна готовится к марафону", kind: "fact", scope: "family",
        confirmation: "model_high", sensitivity: "normal",
        source: condition === "evidence_only" ? "eve:another:turn" : "eve:eve-broken:turn-broken",
        operationKey: "unexpected-write", provenance: { sessionId: condition === "evidence_only" ? "another" : "eve-broken", turnId: "turn-broken" },
        explicitSource: { conversationId: fixture.conversationId, timelineEntryId: fixture.timelineEntryId, subject: { kind: "current_author" } },
      });
      if (condition === "retained_operation") await database().query("DELETE FROM memory_items_all");
      if (condition === "evidence_only") await database().query("UPDATE claim_evidence SET timeline_entry_id = NULL");
      await expect(skipUnboundMemoryReviewBatch({ batchId: head.batchId,
        reason: condition === "blank_reason" ? "  " : "Ручной разбор" })).rejects.toThrow("AGENT_MEMORY_REVIEW_SKIP_");
      expect(await memoryReviewRepository.getLaneCursor({ conversationId: fixture.conversationId, messageThreadId: null })).toBe("0");
      expect((await database().query("SELECT count(*)::integer AS n FROM memory_review_batch_sources WHERE batch_id=$1", [head.batchId])).rows)
        .toEqual([{ n: condition === "missing_source" ? 49 : 50 }]);
    },
  );

  it("does not skip a later failed packet while a different head still blocks the cursor", async () => {
    const { head } = await incident();
    const later = (await database().query<{ id: string }>(
      `UPDATE memory_review_batches SET status='failed', diagnostic_code=$1, completed_at=now(),
        eve_session_id='eve-later', eve_turn_id='turn-later'
        WHERE predecessor_sequence=50 RETURNING id`, [SOURCE_MISSING],
    )).rows[0]!.id;
    await expect(skipUnboundMemoryReviewBatch({ batchId: later, reason: "Не тот пакет" }))
      .rejects.toThrow("AGENT_MEMORY_REVIEW_SKIP_STATE_INVALID");
    expect((await inspectMemoryReviewLanes())[0]).toMatchObject({ batchId: head.batchId, processedThroughSequence: "0" });
  });
});
