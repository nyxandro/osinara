/**
 * Turn-scoped announcement of the reaction set Telegram accepts in the current chat.
 *
 * Export:
 * - `reactionSetInstructions`: user-role block carrying the verified set, authored once per change.
 *
 * It follows the mode rules that reference it. The set is user-role because it belongs to the
 * conversation and must survive as one announcement instead of being rebuilt into the system prefix
 * on every turn.
 */
import { resolveReactionSetBlock } from "../lib/prompt/turn-blocks.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import type { InstructionResolver } from "../runtime/prompt/turn-instructions.js";

export const reactionSetInstructions: InstructionResolver = {
  name: "reaction-set",
  async resolve(ctx) {
    if (isMemoryReviewSession(ctx)) return null;
    const content = await resolveReactionSetBlock(ctx);
    return content === null ? null : { content, role: "user" };
  },
};
