/**
 * Turn-scoped user-managed operational instructions for the exact Telegram chat.
 *
 * Export:
 * - `presentationPreferenceInstructions`: the live-authorized, XML-escaped chat prompt.
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
