/**
 * Turn-scoped conversation mode instructions.
 *
 * Export:
 * - `conversationModeInstructions`: the complete rulebook of the current verified trust zone,
 *   including the effective external-group capability block.
 *
 * It comes first among the turn's blocks (`agent/agent.ts`), so the model reads the world it
 * operates in before any style rule or untrusted data.
 */
import { resolveModeBlock } from "../lib/prompt/turn-blocks.js";
import { memoryReviewInstructions } from "../lib/memory-review/memory-review-prompt.js";
import {
  isMemoryReviewSession,
  memoryReviewScope,
} from "../lib/memory-review/memory-review-session.js";
import type { InstructionResolver } from "../runtime/prompt/turn-instructions.js";

export const conversationModeInstructions: InstructionResolver = {
  name: "conversation-mode",
  async resolve(ctx) {
    return {
      content: isMemoryReviewSession(ctx) ? memoryReviewInstructions(memoryReviewScope(ctx)) : await resolveModeBlock(ctx),
      role: "system",
    };
  },
};
