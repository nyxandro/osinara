/**
 * The built-in `load_skill` tool: the instructions of one skill listed in this turn.
 *
 * Exports:
 * - `loadSkill`: the built-in definition the model sees as `load_skill`.
 * - `formatLoadedSkill`: the text the model receives for a loaded skill.
 *
 * The instructions come from the turn's skill definitions, not from the sandbox. Only a skill that
 * has files writes them there, as an exact copy, and the answer names their directory.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { z } from "zod";

import type { LoadedSkill } from "../skills/definition.js";
import { defineTool } from "../tool.js";

const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;
// A skill such as docx carries dozens of files; the model needs the layout, not every path.
const LISTED_FILES_MAX = 40;

export const LOAD_SKILL_INPUT_SCHEMA = z.strictObject({
  skill: z.string().describe("Available skill name or id."),
});

export function formatLoadedSkill(skill: LoadedSkill): string {
  const instructions = skill.markdown.replace(FRONTMATTER_PATTERN, "");
  if (skill.files === null) return instructions;
  const listed = skill.files.paths.slice(0, LISTED_FILES_MAX);
  const more = skill.files.paths.length - listed.length;
  return [
    instructions.trimEnd(),
    "",
    `Skill files: \`${skill.files.directory}/\` (${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""}).`,
  ].join("\n");
}

export const loadSkill = defineTool({
  description: [
    "Load the full instructions for one available skill by name or id.",
    "Use this tool when the request clearly matches a listed skill description or when the user explicitly asks for that skill.",
    "Loading adds the skill instructions to the current turn.",
    'Choose the "skill" value from the Available skills block.',
  ].join(" "),
  async execute({ skill }, ctx) {
    return formatLoadedSkill(await ctx.loadSkill(skill));
  },
  inputSchema: LOAD_SKILL_INPUT_SCHEMA,
  replaySafe: true,
});
