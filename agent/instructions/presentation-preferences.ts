/**
 * The notes of the exact Telegram chat, resolved for every turn.
 *
 * Export:
 * - `presentationPreferenceInstructions`: the live-authorized, XML-escaped chat notes. The block is
 *   a system instruction here and rides in the turn tail at the transport boundary
 *   (`lib/prompt/turn-memory-projection.ts`), so editing the notes leaves the cached history intact.
 */
import { resolvePreferenceBlock } from "../lib/prompt/turn-blocks.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import type { InstructionResolver } from "../runtime/prompt/turn-instructions.js";

export const presentationPreferenceInstructions: InstructionResolver = {
  name: "presentation-preferences",
  async resolve(ctx) {
    if (isMemoryReviewSession(ctx)) return null;
    const content = await resolvePreferenceBlock(ctx);
    return content === null ? null : { content, role: "system" };
  },
};
