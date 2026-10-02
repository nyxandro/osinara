/**
 * Which memory-review batch a finishing Telegram turn belongs to.
 *
 * Export:
 * - `resolveMemoryReviewBatch`: the durable turn binding, through continuations, before a caller's
 *   batch marker.
 */
import type { SessionContext } from "../../runtime/context.js";

import { memoryReviewBatchId } from "./memory-review-session.js";
import { memoryReviewRepository } from "./memory-review-repository.js";

/**
 * Which batch, if any, the finished turn was reviewing, and the turn the batch is bound to.
 *
 * The marker in the current authorization answers this for the turn that started under it, and
 * still answers it when a terminal event is replayed after the batch was released. It cannot
 * answer for a continuation after a human answer, which carries the authorization of that answer;
 * the binding written at the review turn's start is durable and is found through the turns the
 * continuation resumes.
 */
export async function resolveMemoryReviewBatch(ctx: {
  session: {
    auth: SessionContext["session"]["auth"];
    id: string;
    turn: { id: string };
  };
}): Promise<{ batchId: string; eveTurnId: string } | null> {
  const bound = await memoryReviewRepository.batchForTurn({
    eveSessionId: ctx.session.id,
    eveTurnId: ctx.session.turn.id,
  });
  if (bound) return bound;
  // Released batches have no row; their original marker keeps a repeated terminal event a no-op.
  const marker = memoryReviewBatchId(ctx);
  return marker === null ? null : { batchId: marker, eveTurnId: ctx.session.turn.id };
}
