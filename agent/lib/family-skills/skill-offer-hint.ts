/**
 * The application's hint that the previous task may be worth saving as a skill (an idea from Mia).
 *
 * Export:
 * - `previousTaskStepsHint`: in a person's private chat, after a completed turn that took
 *   `SKILL_HINT_MIN_STEPS` or more working tool calls, one user-role line for the next turn naming
 *   how many and which tools. `null` everywhere else.
 *
 * The count comes from the turn journal (`agent_tool_calls`), so no model is asked and nothing new
 * is stored: the hint exists only in the turn right after the long one. Service calls do not count,
 * and a turn that already worked with skills (`manage_skill`, or loading a family skill) gives none.
 * Whether to offer a skill stays the agent's call under the private chat's rules.
 */
import type { Pool } from "pg";

import { resolveConversationEnvironment } from "../conversation-environment.js";
import { isGroupSafeSkillName } from "../group-skills/group-skill-catalog.js";
import { isServiceSkillName } from "./service-skills.js";

// Mia's threshold: four working calls make a task more than a quick answer.
export const SKILL_HINT_MIN_STEPS = 4;
const SERVICE_TOOLS = new Set(["ask_question", "list_memories", "load_skill", "remember", "search_memories", "todo"]);

interface HintContext {
  readonly channel: { readonly kind?: string };
  readonly session: { readonly auth: Parameters<typeof resolveConversationEnvironment>[0]; readonly id: string };
  readonly turnId: string;
}

export async function previousTaskStepsHint(
  database: Pick<Pool, "query">, ctx: HintContext, options: { readonly scheduledRun: boolean },
): Promise<string | null> {
  if (options.scheduledRun || ctx.channel.kind === "subagent") return null;
  if (resolveConversationEnvironment(ctx.session.auth) !== "private") return null;
  const previous = (await database.query<{ id: string; resumes_turn_id: string | null; status: string }>(
    `SELECT id, status, resumes_turn_id FROM agent_turns
      WHERE session_id = $1 AND kind = 'conversation'
        AND sequence < (SELECT sequence FROM agent_turns WHERE id = $2)
      ORDER BY sequence DESC LIMIT 1`,
    [ctx.session.id, ctx.turnId],
  )).rows[0];
  if (previous === undefined || previous.status !== "completed") return null;
  // A turn resumed after a confirmation continues the task its parked turn began.
  const turnIds = previous.resumes_turn_id === null ? [previous.id] : [previous.id, previous.resumes_turn_id];
  const calls = (await database.query<{ skill: string | null; tool_name: string }>(
    `SELECT tool_name, input->>'skill' AS skill FROM agent_tool_calls
      WHERE turn_id = ANY($1::text[]) AND state = 'completed' ORDER BY created_at, position`,
    [turnIds],
  )).rows;
  const familySkillLoaded = calls.some((call) => call.tool_name === "load_skill" && call.skill !== null &&
    !isGroupSafeSkillName(call.skill) && !isServiceSkillName(call.skill));
  if (familySkillLoaded || calls.some((call) => call.tool_name === "manage_skill")) return null;
  const working = calls.filter((call) => !SERVICE_TOOLS.has(call.tool_name));
  if (working.length < SKILL_HINT_MIN_STEPS) return null;
  const tools = [...new Set(working.map((call) => call.tool_name))];
  return `<previous_task_steps>The previous task in this conversation took ${working.length} tool steps: ${tools.join(", ")}.</previous_task_steps>`;
}
