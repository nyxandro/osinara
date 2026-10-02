/**
 * Which memory-review batch a finishing Telegram turn belongs to.
 *
 * Export:
 * - `resolveMemoryReviewBatch`: exact durable turn binding before a caller's batch marker.
 */
import type { SessionContext } from "../../runtime/context.js";

import { memoryReviewBatchId } from "./memory-review-session.js";
import { memoryReviewRepository } from "./memory-review-repository.js";

/**
 * Which batch, if any, the finished turn was reviewing.
 *
 * The marker in the current authorization answers this for the turn that started under it, and
 * still answers it when Eve replays that turn's terminal event after the batch was released. It
 * cannot answer for a turn resumed after a human answer, because the resumed turn carries the
 * authorization of that answer; the binding written at turn start is durable and covers that case.
 */
export async function resolveMemoryReviewBatch(ctx: {
  session: {
    auth: SessionContext["session"]["auth"];
    id: string;
    turn: { id: string };
  };
}): Promise<string | null> {
  const bound = await memoryReviewRepository.batchIdForTurn({
    eveSessionId: ctx.session.id,
    eveTurnId: ctx.session.turn.id,
  });
  if (bound) return bound;
  // Released batches have no row; their original marker keeps a repeated terminal event a no-op.
  return memoryReviewBatchId(ctx);
}
