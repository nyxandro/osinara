/**
 * Skills resolved from the current trusted conversation policy.
 *
 * Export:
 * - `resolveScopedSkills`: the turn's safe skill map; group changes apply on the next turn without
 *   session rotation. The service skills follow the tools of the same turn's surface.
 */
import { resolveConversationSkills } from "../lib/group-skills/group-skill-resolver.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import type { DynamicResolveContext } from "../runtime/context.js";
import { resolveToolSurface } from "../tools/capabilities.js";

export async function resolveScopedSkills(ctx: DynamicResolveContext) {
  if (isMemoryReviewSession(ctx)) return {};
  const tools = await resolveToolSurface(ctx);
  return await resolveConversationSkills(ctx.session.auth, { toolNames: new Set(Object.keys(tools)) });
}
