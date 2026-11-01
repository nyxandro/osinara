/**
 * Turn-scoped delegation role instructions for every conversation trust zone.
 *
 * Export:
 * - `delegationInstructions`: interactive root conversations that have the `agent` tool receive
 *   orchestration rules; memory-review and child turns receive no recursive delegation guidance.
 *
 * A channel-authored turn and an external turn without a verified group policy get no `agent`
 * (`agent/tools/capabilities.ts`), so the rules, which tell the model to hand work to it, stay out.
 */
import { ORCHESTRATOR_DELEGATION_RULES } from "../lib/prompt/delegation-fragments.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import { isTelegramChannelSession } from "../lib/telegram-session-actor.js";
import {
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupToolPolicy,
} from "../lib/tool-policy/external-group-policy.js";
import type { InstructionResolver } from "../runtime/prompt/turn-instructions.js";

export const delegationInstructions: InstructionResolver = {
  name: "delegation",
  resolve(ctx) {
    if (ctx.channel.kind === "subagent" || isMemoryReviewSession(ctx)) return null;
    const auth = ctx.session.auth;
    if (isTelegramChannelSession(auth)) return null;
    if (resolveExternalGroupToolPolicy(auth).restricted && resolveExternalGroupPolicyIdentity(auth) === null) return null;
    return { content: ORCHESTRATOR_DELEGATION_RULES, role: "system" };
  },
};
