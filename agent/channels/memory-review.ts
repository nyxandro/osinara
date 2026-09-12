/**
 * Internal silent channel for root-agent memory review.
 *
 * Export:
 * - Authored receive channel that creates task sessions without external delivery.
 *
 * Key constructs:
 * - Lifecycle handlers bind exact batch sources and terminalize the durable application batch.
 */
import { defineChannel, POST } from "eve/channels";

import {
  bindMemoryTurnSources,
  releaseMemoryTurnSources,
} from "../lib/memory-turn-source.js";
import { memoryReviewRepository } from "../lib/memory-review/memory-review-repository.js";
import {
  memoryReviewBatchId,
  memoryReviewBatchIdFromContinuationToken,
  reviewContinuationToken,
} from "../lib/memory-review/memory-review-session.js";
import { memoryReviewDispatchRepository } from "../lib/memory-review/memory-review-dispatch-repository.js";
import { applicationSessionId } from "../lib/sessions/session-context.js";
import { sessionRepository } from "../lib/sessions/session-repository.js";
import { isHookConflictFailure } from "../lib/telegram-session-failure.js";
import { recoverableModelFailureCode } from "../lib/model-failure.js";

export default defineChannel<undefined, void, { batchId: string }>({
  // Eve 0.32 discovers authored receive targets only when the channel owns a route. This route is
  // never a dispatch seam: it is absent from the edge allowlist and rejects every direct request.
  routes: [POST("/internal/memory-review", async () => new Response(null, { status: 404 }))],
  receive(input, { from }) {
    const batchId = input.target.batchId;
    if (!batchId || input.auth?.attributes.memoryReviewBatchId !== batchId) {
      throw new Error(
        "AGENT_MEMORY_REVIEW_HANDOFF_INVALID: Internal review target does not match verified auth",
      );
    }
    const generation = input.auth.attributes.memoryReviewGeneration;
    if (typeof generation !== "string" || !/^(?:0|[1-9]\d*)$/u.test(generation)) throw new Error(
      "AGENT_MEMORY_REVIEW_GENERATION_INVALID: Internal review has no verified attempt number",
    );
    return from(reviewContinuationToken(batchId, Number(generation))).send(input.message, {
      auth: input.auth,
      mode: "task",
    });
  },
  events: {
    async "turn.started"(_data, _channel, ctx) {
      const batchId = memoryReviewBatchId(ctx);
      if (!batchId) throw new Error(
        "AGENT_MEMORY_REVIEW_CONTEXT_INVALID: Internal review turn has no batch",
      );
      const appSessionId = applicationSessionId(ctx);
      await sessionRepository.bindEveSession(appSessionId, ctx.session.id);
      await memoryReviewRepository.bindEveTurn({
        applicationSessionId: appSessionId,
        batchId,
        eveSessionId: ctx.session.id,
        eveTurnId: ctx.session.turn.id,
      });
      await bindMemoryTurnSources(ctx);
    },
    async "turn.completed"(_data, _channel, ctx) {
      const batchId = memoryReviewBatchId(ctx);
      if (!batchId) throw new Error(
        "AGENT_MEMORY_REVIEW_CONTEXT_INVALID: Completed review turn has no batch",
      );
      const terminal = await memoryReviewRepository.completeBatch({
        batchId,
        completedAt: new Date(),
        eveSessionId: ctx.session.id,
        eveTurnId: ctx.session.turn.id,
      });
      await releaseMemoryTurnSources(ctx);
      if (terminal === "replayed") return;
    },
    async "turn.failed"(data, _channel, ctx) {
      const batchId = memoryReviewBatchId(ctx);
      if (!batchId) throw new Error(
        "AGENT_MEMORY_REVIEW_CONTEXT_INVALID: Failed review turn has no batch",
      );
      const terminal = await memoryReviewRepository.failRunning({
        batchId,
        diagnosticCode: recoverableModelFailureCode(data) ?? data.code,
        eveSessionId: ctx.session.id,
        eveTurnId: ctx.session.turn.id,
      });
      await releaseMemoryTurnSources(ctx);
      if (terminal === "replayed") return;
    },
    async "turn.cancelled"(_data, _channel, ctx) {
      const batchId = memoryReviewBatchId(ctx);
      if (!batchId) return;
      const terminal = await memoryReviewRepository.failRunning({
        batchId,
        diagnosticCode: "AGENT_MEMORY_REVIEW_TURN_CANCELLED",
        eveSessionId: ctx.session.id,
        eveTurnId: ctx.session.turn.id,
      });
      await releaseMemoryTurnSources(ctx);
      if (terminal === "replayed") return;
    },
    async "session.failed"(data, channel) {
      // A competing root lost channel ownership; the existing review root remains authoritative.
      if (isHookConflictFailure(data)) return;
      const batchId = memoryReviewBatchIdFromContinuationToken(
        channel.continuation?.token ?? "",
      );
      if (!batchId) throw new Error(
        "AGENT_MEMORY_REVIEW_CONTINUATION_INVALID: Failed review session has no batch route",
      );
      await memoryReviewDispatchRepository.markSessionAmbiguous({
        batchId,
        diagnosticCode: recoverableModelFailureCode(data) ?? "AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS",
        eveSessionId: data.sessionId,
      });
    },
  },
});
