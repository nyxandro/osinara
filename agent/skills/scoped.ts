/**
 * Skills resolved from the current trusted conversation policy.
 *
 * Export:
 * - `resolveScopedSkills`: the turn's safe skill map; group changes apply on the next turn without
 *   session rotation.
 */
import { isScheduledSession } from "../lib/agent-schedules/scheduled-session.js";
import { resolveConversationSkills } from "../lib/group-skills/group-skill-resolver.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import type { DynamicResolveContext } from "../runtime/context.js";

export async function resolveScopedSkills(ctx: DynamicResolveContext) {
  if (isMemoryReviewSession(ctx)) return {};
  return await resolveConversationSkills(ctx.session.auth, {
    scheduledRun: isScheduledSession(ctx),
    subagent: ctx.channel.kind === "subagent",
  });
}
