/** A provider outage suspends one review, keeping its sources and conversation usable. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, type PoolClient } from "pg";
import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryTurnSourceRepository } from "../memory-turn-source-repository.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryReviewSessionRepository } from "./memory-review-session-repository.js";
import { insertReviewUserMessage } from "./memory-review.integration-fixtures.js";
import { recordSuccessfulModelCall } from "../model-availability-repository.js";
import { memoryRepository } from "../memory-repository.js";
import { pruneTelegramGroupJournal } from "../telegram-group-message-storage.js";
import { recoverEmptyReviewModelFailure } from "./memory-review-model-admin.js";
import { createConfiguredLanguageModel } from "../model-transport.js";
import { modelRouteKey } from "../model-route.js";
import { recoverableModelFailureCode } from "../model-failure.js";
import { reconcileMemoryReviewExecutions } from "./memory-review-execution-reconciliation.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const claim = () => memoryReviewDispatchRepository.claimPending({ leaseMilliseconds: 60_000, limit: 10, now: new Date() });

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function runningReview(eveId = "eve-model-failure") {
  const fixture = await createMainAgentMemoryFixture();
  for (let sequence = 2; sequence <= 50; sequence++) {
    const message = await insertReviewUserMessage({ ...fixture, sequence });
    await memoryReviewRepository.observePassiveMessage({ groupId: fixture.groupId, timelineEntryId: message.id });
  }
  const [batch] = await claim();
  const session = await memoryReviewSessionRepository.prepare(batch!, new Date());
  await memoryReviewDispatchRepository.markDispatchStarted(batch!, session.id);
  await sessionRepository.bindEveSession(session.id, eveId);
  await memoryReviewRepository.bindEveTurn({ batchId: batch!.batchId, applicationSessionId: session.id,
    eveSessionId: eveId, eveTurnId: "turn_0" });
  await memoryTurnSourceRepository.bindReview({ applicationSessionId: session.id,
    conversationId: fixture.conversationId, memoryReviewBatchId: batch!.batchId,
    sourceEntryIds: batch!.sourceEntryIds, eveSessionId: eveId, eveTurnId: "turn_0",
    invokingActorId: fixture.auth.telegramActorId!, invokingActorKind: "telegram_user" });
  return { fixture, batch: batch!, session };
}

(enabled ? describe : describe.skip)("memory review model recovery", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families, model_availability CASCADE"); });
  afterAll(closeDatabase);
  it.each(["cancelled","failed"])("closes the exact application session when native %s cannot be retried", async status => {
    const { batch,session }=await runningReview();
    await database().query("UPDATE memory_review_batches SET infrastructure_recovery_attempts=1,updated_at=now()-interval '2 minutes' WHERE id=$1", [batch.batchId]);
    await reconcileMemoryReviewExecutions(async () => status);
    expect((await database().query("SELECT task_state,retired_at FROM conversation_sessions WHERE id=$1", [session.id])).rows[0])
      .toMatchObject({ task_state: "failed",retired_at: expect.any(Date) });
    expect((await database().query("SELECT count(*)::int AS n FROM memory_turn_source_sets WHERE memory_review_batch_id=$1", [batch.batchId])).rows[0].n).toBe(0);
    expect((await database().query("SELECT count(*)::int AS n FROM memory_review_batch_sources WHERE batch_id=$1", [batch.batchId])).rows[0].n).toBe(50);
  });
  it("does not count partial memory as reviewed when Workflow completed with an agent failure", async () => {
    const tag=crypto.randomUUID().replaceAll("-","").slice(0,26).toUpperCase();
    const eveId=`wrun_${tag}`;
    const { fixture,batch } = await runningReview(eveId);
    await memoryRepository.create(fixture.auth, {
      memoryReviewBatchId: batch.batchId,confirmation: "model_high",content: "Анна готовится к марафону",kind: "fact",scope: "family",
      sensitivity: "normal",operationKey: "partial-native-result",source: `eve:${eveId}:turn_0`,
      provenance: { sessionId: eveId,turnId: "turn_0" },systemActor: true,
      explicitSource: { conversationId: fixture.conversationId,timelineEntryId: batch.sourceEntryIds[0]!,subject: { kind: "current_author" } },
    });
    await database().query("UPDATE memory_review_batches SET updated_at=now()-interval '2 minutes' WHERE id=$1", [batch.batchId]);
    const native = new Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
    await native.connect();
    try {
      await native.query("INSERT INTO workflow.workflow_runs(id,name,status,deployment_id) VALUES($1,'failed-agent-test','completed','test')", [eveId]);
      await native.query("INSERT INTO workflow.workflow_stream_chunks(id,stream_id,run_id,data,eof) VALUES($1,$2,$3,$4,false)",
        [`chnk_${tag}`,`strm_${tag}_user`,eveId,Buffer.from(JSON.stringify({ type: "turn.failed",data: { turnId: "turn_0",code: "MODEL_CALL_FAILED" } })+"\n")]);
      await reconcileMemoryReviewExecutions();
      expect((await database().query("SELECT status,diagnostic_code FROM memory_review_batches WHERE id=$1", [batch.batchId])).rows)
        .toEqual([{ status: "failed",diagnostic_code: "AGENT_MEMORY_REVIEW_PARTIAL_RESULT" }]);
      expect(await memoryReviewRepository.getLaneCursor({ conversationId: fixture.conversationId,messageThreadId: null })).toBe("0");
      expect((await database().query("SELECT count(*)::int AS n FROM memory_review_batch_sources WHERE batch_id=$1", [batch.batchId])).rows[0].n).toBe(50);
    } finally {
      await native.query("DELETE FROM workflow.workflow_stream_chunks WHERE run_id=$1", [eveId]);
      await native.query("DELETE FROM workflow.workflow_runs WHERE id=$1", [eveId]);
      await native.end();
    }
  });

  it("reconciles a terminal empty native task once when its application failure event was lost", async () => {
    const { batch } = await runningReview();
    await database().query("UPDATE memory_review_batches SET updated_at=now()-interval '2 minutes' WHERE id=$1", [batch.batchId]);
    const readStatus = vi.fn().mockResolvedValue("failed");
    await reconcileMemoryReviewExecutions(readStatus);
    await reconcileMemoryReviewExecutions(readStatus);
    expect(readStatus).toHaveBeenCalledOnce();
    expect((await database().query("SELECT status,infrastructure_recovery_attempts,model_recovery_generation FROM memory_review_batches WHERE id=$1", [batch.batchId])).rows)
      .toEqual([{ status: "pending", infrastructure_recovery_attempts: 1, model_recovery_generation: 1 }]);
    expect((await database().query("SELECT count(*)::int AS n FROM memory_review_batch_sources WHERE batch_id=$1", [batch.batchId])).rows[0].n).toBe(50);
  });

  it("leaves an actually running native task untouched regardless of observer age", async () => {
    const { batch } = await runningReview();
    await database().query("UPDATE memory_review_batches SET updated_at=now()-interval '2 hours' WHERE id=$1", [batch.batchId]);
    await reconcileMemoryReviewExecutions(async () => "running");
    expect((await database().query("SELECT status,model_recovery_generation FROM memory_review_batches WHERE id=$1", [batch.batchId])).rows)
      .toEqual([{ status: "running", model_recovery_generation: 0 }]);
  });

  it("waits after a confirmed model timeout without losing sources or retrying on every tick", async () => {
    const { batch } = await runningReview();
    await memoryReviewDispatchRepository.markSessionAmbiguous({ batchId: batch.batchId,
      eveSessionId: "eve-model-failure", diagnosticCode: "AGENT_MODEL_FIRST_CHUNK_TIMEOUT" });
    const current = await database().query("SELECT status, diagnostic_code FROM memory_review_batches WHERE id = $1", [batch.batchId]);
    expect(current.rows).toEqual([{ status: "waiting_model", diagnostic_code: "AGENT_MODEL_FIRST_CHUNK_TIMEOUT" }]);
    await closeDatabase();
    expect(await claim()).toEqual([]);
    expect(await claim()).toEqual([]);
    expect((await database().query("SELECT count(*)::int AS count FROM memory_review_batch_sources WHERE batch_id = $1", [batch.batchId])).rows)
      .toEqual([{ count: 50 }]);
  });

  async function wait(batchId: string, eveSessionId = "eve-model-failure") {
    await memoryReviewDispatchRepository.markSessionAmbiguous({ batchId, eveSessionId, diagnosticCode: "AGENT_MODEL_FIRST_CHUNK_TIMEOUT" });
    return (await database().query<{ model_route_key: string; waiting_since: Date }>(
      "SELECT model_route_key, waiting_since FROM memory_review_batches WHERE id = $1", [batchId])).rows[0]!;
  }

  it("recovers once from another successful call, rebinds the same sources and advances the cursor", async () => {
    const { fixture, batch, session } = await runningReview();
    const waiting = await wait(batch.batchId);
    const signal = { requestId: crypto.randomUUID(), routeKey: waiting.model_route_key, observedAt: new Date(waiting.waiting_since.getTime() + 10) };
    await recordSuccessfulModelCall({ ...signal, routeKey: "a".repeat(64) });
    expect(await claim()).toEqual([]);
    await recordSuccessfulModelCall(signal);
    const results = await Promise.all([claim(), claim()]);
    const resumed = results.flat();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.batchId).toBe(batch.batchId);
    expect(resumed[0]?.sourceEntryIds).toEqual(batch.sourceEntryIds);
    const next = await memoryReviewSessionRepository.prepare(resumed[0]!, new Date());
    expect(next.generation).toBe(1);
    expect(next.id).not.toBe(session.id);
    expect(next.continuationToken).not.toBe(session.continuationToken);
    await memoryReviewDispatchRepository.markDispatchStarted(resumed[0]!, next.id);
    await sessionRepository.bindEveSession(next.id, "eve-recovered");
    await memoryReviewRepository.bindEveTurn({ batchId: batch.batchId, applicationSessionId: next.id, eveSessionId: "eve-recovered", eveTurnId: "turn_0" });
    await memoryTurnSourceRepository.bindReview({ applicationSessionId: next.id,
      conversationId: fixture.conversationId, memoryReviewBatchId: batch.batchId, sourceEntryIds: batch.sourceEntryIds,
      eveSessionId: "eve-recovered", eveTurnId: "turn_0", invokingActorId: fixture.auth.telegramActorId!, invokingActorKind: "telegram_user" });
    await expect(memoryReviewRepository.completeBatch({ batchId: batch.batchId, completedAt: new Date(),
      eveSessionId: "eve-model-failure", eveTurnId: "turn_0" })).resolves.toBe("replayed");
    await memoryReviewRepository.completeBatch({ batchId: batch.batchId, completedAt: new Date(), eveSessionId: "eve-recovered", eveTurnId: "turn_0" });
    expect(await memoryReviewRepository.getLaneCursor({ conversationId: fixture.conversationId, messageThreadId: null })).toBe("50");
    expect((await database().query("SELECT count(*)::int AS count FROM audit_events WHERE event_type = 'memory_review.model_recovered' AND subject_id = $1", [batch.batchId])).rows)
      .toEqual([{ count: 1 }]);
  });

  it("requires a newer success after the recovered attempt fails again", async () => {
    const { batch } = await runningReview();
    const waiting = await wait(batch.batchId);
    const signal = { requestId: crypto.randomUUID(), routeKey: waiting.model_route_key, observedAt: new Date(waiting.waiting_since.getTime() + 10) };
    await recordSuccessfulModelCall(signal);
    const [resumed] = await claim();
    const next = await memoryReviewSessionRepository.prepare(resumed!, new Date());
    await memoryReviewDispatchRepository.markDispatchStarted(resumed!, next.id);
    await sessionRepository.bindEveSession(next.id, "eve-recovered");
    await memoryReviewRepository.bindEveTurn({ batchId: batch.batchId, applicationSessionId: next.id, eveSessionId: "eve-recovered", eveTurnId: "turn_0" });
    const secondWait = await wait(batch.batchId, "eve-recovered");
    await recordSuccessfulModelCall(signal);
    expect(await claim()).toEqual([]);
    // An old observation arriving late is not a new proof of availability.
    await recordSuccessfulModelCall({ ...signal, requestId: crypto.randomUUID(), observedAt: new Date(secondWait.waiting_since.getTime() - 1) });
    expect(await claim()).toEqual([]);
    await recordSuccessfulModelCall({ ...signal, requestId: crypto.randomUUID(), observedAt: new Date(secondWait.waiting_since.getTime() + 10) });
    expect(await claim()).toHaveLength(1);
  });

  it("keeps a partially written review blocked instead of counting one fact as a completed batch", async () => {
    const { fixture, batch } = await runningReview();
    await memoryRepository.create(fixture.auth, {
      memoryReviewBatchId: batch.batchId, confirmation: "model_high", content: "Анна готовится к марафону", kind: "fact",
      scope: "family", sensitivity: "normal", operationKey: "partial-write", source: "eve:eve-model-failure:turn_0",
      provenance: { sessionId: "eve-model-failure", turnId: "turn_0" }, systemActor: true,
      explicitSource: { conversationId: fixture.conversationId, timelineEntryId: batch.sourceEntryIds[0]!, subject: { kind: "current_author" } },
    });
    await memoryReviewRepository.failRunning({ batchId: batch.batchId, diagnosticCode: "AGENT_MODEL_STREAM_TIMEOUT", eveSessionId: "eve-model-failure", eveTurnId: "turn_0" });
    expect((await database().query("SELECT status, diagnostic_code FROM memory_review_batches WHERE id = $1", [batch.batchId])).rows)
      .toEqual([{ status: "failed", diagnostic_code: "AGENT_MEMORY_REVIEW_PARTIAL_RESULT" }]);
    expect(await memoryReviewRepository.getLaneCursor({ conversationId: fixture.conversationId, messageThreadId: null })).toBe("0");
    expect(await claim()).toEqual([]);
  });

  it("rejects an old attempt's delayed memory write after it enters waiting", async () => {
    const { fixture, batch } = await runningReview();
    await wait(batch.batchId);
    await expect(memoryRepository.create(fixture.auth, {
      memoryReviewBatchId: batch.batchId, confirmation: "model_high", content: "Запоздавшая запись", kind: "fact",
      scope: "family", sensitivity: "normal", operationKey: "late-write", source: "eve:eve-model-failure:turn_0",
      provenance: { sessionId: "eve-model-failure", turnId: "turn_0" }, systemActor: true,
      explicitSource: { conversationId: fixture.conversationId, timelineEntryId: batch.sourceEntryIds[0]!, subject: { kind: "current_author" } },
    })).rejects.toMatchObject({ code: "AGENT_MEMORY_REVIEW_ATTEMPT_STALE" });
    expect((await database().query("SELECT count(*)::int AS count FROM memory_mutation_operations")).rows).toEqual([{ count: 0 }]);
  });

  it("retains the unbatched tail when the journal exceeds its ordinary retention window", async () => {
    const { fixture, batch } = await runningReview();
    await wait(batch.batchId);
    await database().query(`INSERT INTO telegram_group_messages
      (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id, telegram_user_id,
        sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
      SELECT $1, $2, 100000 + n, n, 'user', 'telegram:agent-memory-author', 'agent-memory-author',
        'Анна', false, 'text', 'Непроверенное сообщение', now() FROM generate_series(51, 10070) n`, [fixture.conversationId, fixture.groupId]);
    const client = await database().connect();
    try { await pruneTelegramGroupJournal(client, fixture.groupId); } finally { client.release(); }
    expect((await database().query("SELECT count(*)::int AS count FROM telegram_group_messages WHERE conversation_id = $1", [fixture.conversationId])).rows)
      .toEqual([{ count: 10070 }]);
  });

  it("recovers an explicitly inspected historical failure, but never an unconfirmed running session", async () => {
    const { batch } = await runningReview();
    await memoryReviewDispatchRepository.markSessionAmbiguous({ batchId: batch.batchId,
      eveSessionId: "eve-model-failure", diagnosticCode: "AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS" });
    const row = (await database().query("SELECT model_route_key FROM memory_review_batches WHERE id = $1", [batch.batchId])).rows[0];
    await database().query("UPDATE memory_review_batches SET model_route_key = NULL WHERE id = $1", [batch.batchId]);
    const input = { batchId: batch.batchId, expectedEveSessionId: "eve-model-failure",
      causeCode: "AGENT_MODEL_FIRST_CHUNK_TIMEOUT", modelRouteKey: row.model_route_key, reason: "Проверен таймаут без записей" };
    await expect(recoverEmptyReviewModelFailure(input, { isEveSessionTerminal: async () => false }))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_REVIEW_RECOVERY_SESSION_UNCONFIRMED" });
    expect(await recoverEmptyReviewModelFailure(input, { isEveSessionTerminal: async () => true })).toBe("waiting");
    expect(await recoverEmptyReviewModelFailure(input, { isEveSessionTerminal: async () => true })).toBe("replayed");
    expect((await database().query("SELECT count(*)::int AS count FROM audit_events WHERE event_type = 'memory_review.operator_model_recovery' AND subject_id = $1", [batch.batchId])).rows)
      .toEqual([{ count: 1 }]);
    expect(await claim()).toEqual([]);
  });

  it("uses an actual model transport success as the signal for the waiting review", async () => {
    const { batch } = await runningReview();
    const transport = { protocol: "openai-chat-completions", providerName: "test", baseUrl: "https://model.invalid/v1", reasoning: null } as const;
    const route = modelRouteKey(transport, "test-model");
    await database().query("UPDATE memory_review_batches SET model_route_key = $2 WHERE id = $1", [batch.batchId, route]);
    await wait(batch.batchId);
    const model = createConfiguredLanguageModel({ apiKey: "test", modelId: "test-model", maxOutputTokens: 100,
      transport, onSuccessfulCall: recordSuccessfulModelCall,
      fetch: async () => new Response(JSON.stringify({ id: "completion", created: 1, model: "test-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Готово" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { "content-type": "application/json" } }),
    });
    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Другой разговор" }] }] });
    expect((await claim()).map(item => item.batchId)).toEqual([batch.batchId]);
  });

  it("waits for an in-flight memory transaction before deciding whether the review wrote anything", async () => {
    const { fixture, batch } = await runningReview();
    const reachedInsert = latch();
    const releaseInsert = latch();
    const pool=database();
    const wrapped=new WeakSet<object>();
    const restore: Array<() => void> = [];
    const acquired = (client: PoolClient) => {
      if (wrapped.has(client)) return;
      wrapped.add(client);
      const query=client.query.bind(client);
      const spy=vi.spyOn(client,"query").mockImplementation(((...args: unknown[]) => {
        const execute=() => Reflect.apply(query,client,args);
        if (typeof args[0] === "string" && args[0].includes("INSERT INTO memory_items\n")) {
          reachedInsert.resolve();
          return releaseInsert.promise.then(execute);
        }
        return execute();
      }) as never);
      restore.push(() => spy.mockRestore());
    };
    pool.on("acquire",acquired);
    const write = memoryRepository.create(fixture.auth, {
      memoryReviewBatchId: batch.batchId, confirmation: "model_high", content: "Запись началась до таймаута", kind: "fact",
      scope: "family", sensitivity: "normal", operationKey: "in-flight-write", source: "eve:eve-model-failure:turn_0",
      provenance: { sessionId: "eve-model-failure", turnId: "turn_0" }, systemActor: true,
      explicitSource: { conversationId: fixture.conversationId, timelineEntryId: batch.sourceEntryIds[0]!, subject: { kind: "current_author" } },
    });
    let terminal: Promise<unknown> | undefined;
    try {
      await Promise.race([reachedInsert.promise, write.then(() => { throw new Error("TEST_WRITE_NOT_PAUSED"); })]);
      let classified = false;
      terminal = wait(batch.batchId).then(result => { classified = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(classified).toBe(false);
      releaseInsert.resolve();
      await write;
      await terminal;
      expect((await database().query("SELECT status, diagnostic_code FROM memory_review_batches WHERE id = $1", [batch.batchId])).rows)
        .toEqual([{ status: "failed", diagnostic_code: "AGENT_MEMORY_REVIEW_PARTIAL_RESULT" }]);
    } finally {
      releaseInsert.resolve();
      await Promise.allSettled([write, terminal]);
      pool.off("acquire",acquired);
      for (const undo of restore) undo();
    }
  });

  it("does not skip a network-failed head when a successor already exists", async () => {
    const { fixture, batch } = await runningReview();
    for (let sequence = 51; sequence <= 100; sequence++) {
      const message = await insertReviewUserMessage({ ...fixture, sequence });
      await memoryReviewRepository.observePassiveMessage({ groupId: fixture.groupId, timelineEntryId: message.id });
    }
    const failure = { code: "MODEL_CALL_FAILED", details: { semanticErrorId: "network-request-failed" } };
    await memoryReviewRepository.failRunning({ batchId: batch.batchId,
      diagnosticCode: recoverableModelFailureCode(failure) ?? failure.code,
      eveSessionId: "eve-model-failure", eveTurnId: "turn_0" });
    expect((await database().query("SELECT status FROM memory_review_batches WHERE id = $1", [batch.batchId])).rows)
      .toEqual([{ status: "waiting_model" }]);
    expect(await claim()).toEqual([]);
    expect((await database().query("SELECT count(*)::int AS count FROM memory_review_batch_sources")).rows).toEqual([{ count: 100 }]);
    expect(await memoryReviewRepository.getLaneCursor({ conversationId: fixture.conversationId, messageThreadId: null })).toBe("0");
  });

  it("preserves sources for an unclassified background failure instead of silently replaying them", async () => {
    const { batch } = await runningReview();
    await memoryReviewRepository.failRunning({ batchId: batch.batchId, diagnosticCode: "UNCLASSIFIED_REVIEW_ERROR",
      eveSessionId: "eve-model-failure", eveTurnId: "turn_0" });
    expect((await database().query("SELECT status, diagnostic_code FROM memory_review_batches WHERE id = $1", [batch.batchId])).rows)
      .toEqual([{ status: "failed", diagnostic_code: "UNCLASSIFIED_REVIEW_ERROR" }]);
    expect(await claim()).toEqual([]);
    expect((await database().query("SELECT count(*)::int AS count FROM memory_review_batch_sources WHERE batch_id = $1", [batch.batchId])).rows)
      .toEqual([{ count: 50 }]);
  });

  it("does not wait on a session locked for retention and recovers after its FK is cleared", async () => {
    const { batch, session } = await runningReview();
    const waiting = await wait(batch.batchId);
    await recordSuccessfulModelCall({ requestId: crypto.randomUUID(), routeKey: waiting.model_route_key,
      observedAt: new Date(waiting.waiting_since.getTime() + 10) });
    const token = crypto.randomUUID();
    await database().query("UPDATE conversation_sessions SET retention_lease_token = $2, retention_lease_expires_at = now() + interval '1 minute' WHERE id = $1", [session.id, token]);
    const retention = await database().connect();
    let pending: ReturnType<typeof claim> | undefined;
    let result: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await retention.query("BEGIN");
      await retention.query("SELECT id FROM conversation_sessions WHERE id = $1 FOR UPDATE", [session.id]);
      pending = claim();
      result = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve("blocked"), 1_000); })]);
    } finally {
      if (timer) clearTimeout(timer);
      await retention.query("ROLLBACK");
      retention.release();
      await pending;
    }
    expect(result).toEqual([]);
    await sessionRepository.completeDeletion(session.id, token);
    expect((await claim()).map(item => item.batchId)).toEqual([batch.batchId]);
  });
});
