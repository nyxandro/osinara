/**
 * Turn-scoped conversation mode instructions.
 *
 * Export:
 * - Eve dynamic instructions carrying the complete rulebook of the current verified trust zone,
 *   including the effective external-group capability block.
 *
 * The filename orders this block before presentation preferences and retrieved memory, so the
 * model reads the world it operates in before any style rule or untrusted data.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { resolveModeBlock } from "../lib/prompt/turn-blocks.js";
import { memoryReviewInstructions } from "../lib/memory-review/memory-review-prompt.js";
import {
  isMemoryReviewSession,
  memoryReviewScope,
} from "../lib/memory-review/memory-review-session.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => defineInstructions({
      markdown: isMemoryReviewSession(ctx)
        ? memoryReviewInstructions(memoryReviewScope(ctx))
        : await resolveModeBlock(ctx),
    }),
  },
});
