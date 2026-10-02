/**
 * Tool surface for the current verified conversation mode.
 *
 * Export:
 * - `resolveToolSurface`: the step's tool map resolved from verified auth and the live
 *   external-group policy.
 *
 * Key constructs:
 * - One resolver owns the whole application surface, so mode and capability policy stay consistent.
 * - The runtime calls it before every model call, so a revoked capability leaves the next step.
 * - Tool and skill policy share verified auth; execution still rechecks live revocation.
 * - Each independent policy lookup fails closed for its own application capability class.
 */
import type { DynamicResolveContext } from "../runtime/context.js";
import { resolveConversationEnvironment } from "../lib/conversation-environment.js";
import { resolveExternalGroupSkillNames } from "../lib/group-skills/group-skill-resolver.js";
import { scheduledGroupHistoryAccess } from "../lib/agent-schedules/scheduled-group-history-context.js";
import { isScheduledSession } from "../lib/agent-schedules/scheduled-session.js";
import { loadCurrentExternalGroupCapabilities } from "../lib/tool-policy/external-group-live-policy.js";
import {
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupToolPolicy,
} from "../lib/tool-policy/external-group-policy.js";
import type { ExternalGroupToolName } from "../lib/tool-policy/group-tool-catalog.js";
import {
  buildModeToolSurface,
  buildSubagentToolSurface,
} from "../lib/tool-policy/mode-tool-surface.js";
import {
  isMemoryReviewSession,
  memoryReviewScope,
} from "../lib/memory-review/memory-review-session.js";
import { buildMemoryReviewToolSurface } from "../lib/memory-review/memory-review-tool-surface.js";
import { isTelegramChannelSession } from "../lib/telegram-session-actor.js";

export async function resolveToolSurface(ctx: DynamicResolveContext) {
  if (isMemoryReviewSession(ctx)) {
    const reviewScope = memoryReviewScope(ctx);
    if (ctx.session.auth.current?.attributes.groupType !== "external") {
      return buildMemoryReviewToolSurface(reviewScope);
    }
    const identity = resolveExternalGroupPolicyIdentity(ctx.session.auth);
    const snapshot = resolveExternalGroupToolPolicy(ctx.session.auth);
    if (!identity || !snapshot.restricted) {
      return buildMemoryReviewToolSurface(reviewScope, new Set());
    }
    try {
      const current = await loadCurrentExternalGroupCapabilities(identity);
      return buildMemoryReviewToolSurface(reviewScope, new Set(
        [...snapshot.allowed].filter((name) => current.has(name)),
      ));
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_MEMORY_REVIEW_TOOL_POLICY_LOOKUP_FAILED",
        error: error instanceof Error ? error.message : String(error),
        groupId: identity.groupId,
      }));
      return buildMemoryReviewToolSurface(reviewScope, new Set());
    }
  }
  const auth = ctx.session.auth;
  const buildSurface = ctx.channel.kind === "subagent"
    ? buildSubagentToolSurface
    : buildModeToolSurface;
  let environment: ReturnType<typeof resolveConversationEnvironment>;
  try {
    environment = resolveConversationEnvironment(auth);
  } catch (error) {
    // Without a proven trust zone there is no surface to expose. The instructions resolver
    // separately tells the model that this turn cannot use tools at all.
    console.error(JSON.stringify({
      code: "AGENT_TOOL_SURFACE_ENVIRONMENT_INVALID",
      error: error instanceof Error ? error.message : String(error),
    }));
    return buildSurface({
      capabilities: new Set(),
      environment: "external",
      includeApplicationCore: false,
      skills: new Set(),
    });
  }
  if (environment !== "external") {
    const surface = buildSurface({ environment, scheduledRun: isScheduledSession(ctx) });
    if (auth.current?.attributes.telegramApprovalContinuation === "true") {
      const continuation = { ...surface };
      // A control response is not a verified new message for facts or style mutations.
      delete continuation.remember;
      delete continuation.manage_behavior_preference;
      return continuation;
    }
    return surface;
  }

  // A visible channel is not a human authority. It may receive a text response in the external
  // group, while every application capability stays descriptor-absent for this turn.
  if (isTelegramChannelSession(auth)) {
    return buildSurface({
      capabilities: new Set(),
      environment: "external",
      includeApplicationCore: false,
      skills: new Set(),
    });
  }

  const policy = resolveExternalGroupToolPolicy(auth);
  const identity = resolveExternalGroupPolicyIdentity(auth);
  if (!policy.restricted || !identity) {
    return buildSurface({
      capabilities: new Set(),
      environment: "external",
      includeApplicationCore: false,
      skills: new Set(),
    });
  }

  // Intersection prevents a stale verified session from gaining capabilities outside its auth
  // snapshot. Execution wrappers independently enforce revocation after this turn boundary.
  let current: ReadonlySet<ExternalGroupToolName> = new Set();
  let includeApplicationCore = true;
  try {
    current = await loadCurrentExternalGroupCapabilities(identity);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GROUP_TOOL_POLICY_LOOKUP_FAILED",
      error: error instanceof Error ? error.message : String(error),
      groupId: identity.groupId,
    }));
    // R0-R7 core tools also rely on a current external registration, while independently
    // live-checked skills may still remain available for this turn.
    includeApplicationCore = false;
  }

  // Skills are the turn's verified list that the group's live list still grants. Live execution
  // still denies a skill that the owner revokes while this turn is running.
  let skills: ReadonlySet<string> = new Set();
  try {
    skills = await resolveExternalGroupSkillNames(auth);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GROUP_SKILL_POLICY_LOOKUP_FAILED",
      error: error instanceof Error ? error.message : String(error),
      groupId: identity.groupId,
    }));
  }
  return buildSurface({
    capabilities: new Set([...policy.allowed].filter((name) => current.has(name))),
    environment: "external",
    includeApplicationCore,
    scheduledHistory: includeApplicationCore && scheduledGroupHistoryAccess(auth) !== null,
    scheduledRun: isScheduledSession(ctx),
    skills,
  });
}
