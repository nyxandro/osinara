/**
 * The built-in `load_skill` tool: the instructions of one skill listed in this turn.
 *
 * Exports:
 * - `loadSkill`: the built-in definition the model sees as `load_skill`.
 * - `loadSkillFromSandbox`: reads `SKILL.md` under the sandbox skill root without its front matter.
 *
 * Only the turn's listed skills load; the turn syncs their packages into the sandbox before the
 * first step.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { z } from "zod";

import { resolveSandboxSkillRoot } from "../sandbox/paths.js";
import type { SandboxSession } from "../sandbox/types.js";
import { defineTool } from "../tool.js";

const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;

export const LOAD_SKILL_INPUT_SCHEMA = z.strictObject({
  skill: z.string().describe("Available skill name or id."),
});

function assertSafeSkillId(id: string): void {
  if (id.length === 0 || id.trim() !== id || id.startsWith(".") || id.includes("/") || id.includes("\\") ||
    id.includes("..") || /^[A-Za-z]:/u.test(id)) {
    throw new Error('Expected skill id to be a non-empty safe path segment without whitespace, separators, "." prefix, or "..".');
  }
}

export async function loadSkillFromSandbox(
  sandbox: Pick<SandboxSession, "readTextFile" | "run">,
  id: string,
  availableNames: readonly string[],
): Promise<string> {
  assertSafeSkillId(id);
  const path = `${await resolveSandboxSkillRoot(sandbox)}/${id}/SKILL.md`;
  const instructions = await sandbox.readTextFile({ path });
  if (instructions !== null) return instructions.replace(FRONTMATTER_PATTERN, "");
  const hint = availableNames.length > 0 ? ` Available skills: ${availableNames.join(", ")}.` : "";
  throw new Error(`No skill named "${id}" at ${path}.${hint}`);
}

export const loadSkill = defineTool({
  description: [
    "Load the full instructions for one available skill by name or id.",
    "Use this tool when the request clearly matches a listed skill description or when the user explicitly asks for that skill.",
    "Loading adds the skill instructions to the current turn.",
    'Choose the "skill" value from the Available skills block.',
  ].join(" "),
  async execute({ skill }, ctx) {
    const available = [...new Set(ctx.skills)].sort();
    if (!available.includes(skill)) {
      const hint = available.length > 0 ? ` Available skills: ${available.join(", ")}.` : "";
      throw new Error(`No skill named "${skill}".${hint}`);
    }
    return await loadSkillFromSandbox(await ctx.getSandbox(), skill, available);
  },
  inputSchema: LOAD_SKILL_INPUT_SCHEMA,
  replaySafe: true,
});
