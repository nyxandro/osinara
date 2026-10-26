/**
 * Turn-scoped retrieved long-term memory instructions.
 *
 * Export:
 * - `retrievedMemoryInstructions`: only authorized memory records, as untrusted data, and the
 *   profile card of the turn's people.
 *
 * Key construct:
 * - The turn id binds writable profile subject refs to this turn.
 *
 * The memory block lives in the system prompt of this turn only. The retrieved payload is then
 * lifted into the turn tail at the transport boundary by `lib/prompt/turn-memory-projection.ts`;
 * service notices stay in the instruction prefix. The profile card is a user-role block: the runtime
 * writes it into history, so its facts stay in front of the model on the next turns.
 */
import { resolveMemoryBlock } from "../lib/prompt/turn-blocks.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import type { InstructionBlock, InstructionResolver } from "../runtime/prompt/turn-instructions.js";

export const retrievedMemoryInstructions: InstructionResolver = {
  name: "retrieved-memory",
  async resolve(ctx) {
    if (isMemoryReviewSession(ctx)) return null;
    const blocks = await resolveMemoryBlock(ctx, ctx.turnId);
    const resolved: InstructionBlock[] = [];
    if (blocks.memory !== null) resolved.push({ content: blocks.memory, role: "system" });
    if (blocks.profileCard !== null) resolved.push({ content: blocks.profileCard, role: "user" });
    return resolved;
  },
};
