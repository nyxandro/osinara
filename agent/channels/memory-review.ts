/**
 * Internal silent channel for root-agent memory review.
 *
 * Exports:
 * - `MEMORY_REVIEW_CHANNEL_KIND`: the channel kind of review turns, as resolvers see it.
 * - `memoryReviewTurnEvents`: lifecycle handlers that bind exact batch sources and terminalize the
 *   durable application batch.
 * - `createMemoryReviewStart`: starts a batch's review turn in the background, in the session of the
 *   batch's attempt.
 *
 * Key constructs:
 * - The review turn delivers nothing; it writes only through its memory tools.
 * - The batch in the target must be the one the verified auth names, and each recovery attempt gets
 *   its own session (`reviewContinuationToken`).
 */
import type { TurnDispatcher } from "../runtime/dispatch.js";
import { startChannelTurn } from "../runtime/session/channel-session.js";
import type { LifecycleTurnEvents } from "../runtime/turn/lifecycle-observer.js";
import type { JournalDatabase } from "../runtime/turn/journal-repository.js";
import {
  bindMemoryTurnSources,
  releaseMemoryTurnSources,
} from "../lib/memory-turn-source.js";
import type { MemoryReviewStart } from "../lib/memory-review/memory-review-dispatcher.js";
import { memoryReviewRepository } from "../lib/memory-review/memory-review-repository.js";
import { memoryReviewBatchId, reviewContinuationToken } from "../lib/memory-review/memory-review-session.js";
import { applicationSessionId } from "../lib/sessions/session-context.js";
import { sessionRepository } from "../lib/sessions/session-repository.js";
import { recoverableModelFailureCode } from "../lib/model-failure.js";
import { recoverDatabaseBookkeeping } from "../lib/database-recovery.js";

export const MEMORY_REVIEW_CHANNEL_KIND = "memory-review";

export function createMemoryReviewStart(runtime: {
  readonly database: JournalDatabase & Parameters<typeof startChannelTurn>[0];
  readonly dispatcher: Pick<TurnDispatcher, "start">;
}): MemoryReviewStart {
  return async (batchId, message, { auth }) => {
    if (!batchId || auth.attributes.memoryReviewBatchId !== batchId) {
      throw new Error(
        "AGENT_MEMORY_REVIEW_HANDOFF_INVALID: Internal review target does not match verified auth",
      );
    }
    const generation = auth.attributes.memoryReviewGeneration;
    if (typeof generation !== "string" || !/^(?:0|[1-9]\d*)$/u.test(generation)) throw new Error(
      "AGENT_MEMORY_REVIEW_GENERATION_INVALID: Internal review has no verified attempt number",
    );
    const started = await startChannelTurn(runtime.database, {
      auth,
      channel: { kind: MEMORY_REVIEW_CHANNEL_KIND },
      channelState: null,
      input: { context: [], message },
      kind: "memory_review",
      token: reviewContinuationToken(batchId, Number(generation)),
    });
    runtime.dispatcher.start(started.turnId);
    return { sessionId: started.sessionId };
  };
}

export const memoryReviewTurnEvents: LifecycleTurnEvents = {
  async "turn.started"(ctx) {
    const batchId = memoryReviewBatchId(ctx);
    if (!batchId) throw new Error(
      "AGENT_MEMORY_REVIEW_CONTEXT_INVALID: Internal review turn has no batch",
    );
    const appSessionId = applicationSessionId(ctx);
    await sessionRepository.bindAgentSession(appSessionId, ctx.session.id);
    await memoryReviewRepository.bindAgentTurn({
      applicationSessionId: appSessionId,
      batchId,
      agentSessionId: ctx.session.id,
      agentTurnId: ctx.session.turn.id,
    });
    await bindMemoryTurnSources(ctx);
  },
  async "turn.completed"(ctx) {
    const batchId = memoryReviewBatchId(ctx);
    if (!batchId) throw new Error(
      "AGENT_MEMORY_REVIEW_CONTEXT_INVALID: Completed review turn has no batch",
    );
    await recoverDatabaseBookkeeping(() => memoryReviewRepository.completeBatch({
      batchId,
      completedAt: new Date(),
      agentSessionId: ctx.session.id,
      agentTurnId: ctx.session.turn.id,
    }));
    await releaseMemoryTurnSources(ctx);
  },
  async "turn.failed"(data, ctx) {
    const batchId = memoryReviewBatchId(ctx);
    if (!batchId) throw new Error(
      "AGENT_MEMORY_REVIEW_CONTEXT_INVALID: Failed review turn has no batch",
    );
    await recoverDatabaseBookkeeping(() => memoryReviewRepository.failRunning({
      batchId,
      diagnosticCode: recoverableModelFailureCode(data) ?? data.code,
      agentSessionId: ctx.session.id,
      agentTurnId: ctx.session.turn.id,
    }));
    await releaseMemoryTurnSources(ctx);
  },
  async "turn.cancelled"(ctx) {
    const batchId = memoryReviewBatchId(ctx);
    if (!batchId) return;
    await recoverDatabaseBookkeeping(() => memoryReviewRepository.failRunning({
      batchId,
      diagnosticCode: "AGENT_MEMORY_REVIEW_TURN_CANCELLED",
      agentSessionId: ctx.session.id,
      agentTurnId: ctx.session.turn.id,
    }));
    await releaseMemoryTurnSources(ctx);
  },
};
