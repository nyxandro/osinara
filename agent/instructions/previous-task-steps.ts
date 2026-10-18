/**
 * Turn-scoped note that the previous task took many tool steps, so the agent may offer a skill.
 *
 * Export:
 * - `previousTaskStepsInstructions`: user-role block from `previousTaskStepsHint`, or none.
 *
 * User-role, written into history with the turn input: it belongs to this exchange only and must not
 * move the cached system prefix. The note is optional: a failing lookup is logged and the turn goes
 * on without it, since a failing resolver would otherwise stop the whole turn.
 */
import { isScheduledSession } from "../lib/agent-schedules/scheduled-session.js";
import { database } from "../lib/database.js";
import { previousTaskStepsHint } from "../lib/family-skills/skill-offer-hint.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import type { InstructionResolver } from "../runtime/prompt/turn-instructions.js";

export const previousTaskStepsInstructions: InstructionResolver = {
  name: "previous-task-steps",
  async resolve(ctx) {
    if (isMemoryReviewSession(ctx)) return null;
    let content: string | null;
    try {
      content = await previousTaskStepsHint(database(), ctx, { scheduledRun: isScheduledSession(ctx) });
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_SKILL_HINT_FAILED", sessionId: ctx.session.id, turnId: ctx.turnId,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
      return null;
    }
    return content === null ? null : { content, role: "user" };
  },
};
