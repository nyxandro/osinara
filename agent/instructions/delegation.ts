/**
 * Turn-scoped delegation role instructions for every conversation trust zone.
 *
 * Export:
 * - `delegationInstructions`: interactive root conversations receive orchestration rules;
 *   memory-review and child turns receive no recursive delegation guidance.
 */
import { ORCHESTRATOR_DELEGATION_RULES } from "../lib/prompt/delegation-fragments.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import type { InstructionResolver } from "../runtime/prompt/turn-instructions.js";

export const delegationInstructions: InstructionResolver = {
  name: "delegation",
  resolve(ctx) {
    if (ctx.channel.kind === "subagent" || isMemoryReviewSession(ctx)) return null;
    return { content: ORCHESTRATOR_DELEGATION_RULES, role: "system" };
  },
};
