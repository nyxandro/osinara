/**
 * Turn-scoped retrieved long-term memory instructions.
 *
 * Export:
 * - `retrievedMemoryInstructions`: only authorized memory records, as untrusted data.
 *
 * Key construct:
 * - The turn id binds writable profile subject refs to this turn.
 *
 * The block lives in the system prompt of this turn only. The retrieved payload is then lifted
 * into the turn tail at the transport boundary by `lib/prompt/turn-memory-projection.ts`; service
 * notices stay in the instruction prefix.
 */
import { resolveMemoryBlock } from "../lib/prompt/turn-blocks.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import type { InstructionResolver } from "../runtime/prompt/turn-instructions.js";

export const retrievedMemoryInstructions: InstructionResolver = {
  name: "retrieved-memory",
  async resolve(ctx) {
    if (isMemoryReviewSession(ctx)) return null;
    const content = await resolveMemoryBlock(ctx, ctx.turnId);
    return content === null ? null : { content, role: "system" };
  },
};
