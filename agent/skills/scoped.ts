/**
 * Skills resolved from the current trusted conversation policy.
 *
 * Export:
 * - `resolveScopedSkills`: the turn's safe skill map; group changes apply on the next turn without
 *   session rotation. The service skills follow the tools of the same turn's surface; a delegated
 *   child's reading views (#457) do not count, since the procedures of their changes are not its own.
 */
import { resolveConversationSkills } from "../lib/group-skills/group-skill-resolver.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";
import type { DynamicResolveContext } from "../runtime/context.js";
import { SUBAGENT_TOOL_ACTIONS } from "../lib/tool-policy/subagent-tool-names.js";
import { resolveToolSurface } from "../tools/capabilities.js";

export async function resolveScopedSkills(ctx: DynamicResolveContext) {
  if (isMemoryReviewSession(ctx)) return {};
  const tools = await resolveToolSurface(ctx);
  const child = ctx.channel.kind === "subagent";
  const toolNames = Object.keys(tools).filter((name) => !child || !Object.hasOwn(SUBAGENT_TOOL_ACTIONS, name));
  return await resolveConversationSkills(ctx.session.auth, { toolNames: new Set(toolNames) });
}
