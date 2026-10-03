/**
 * The skill list the model sees at the end of the system prompt.
 *
 * Export:
 * - `formatAvailableSkillsSection`: activation rules plus one line per skill with its `SKILL.md`
 *   path under the sandbox skill root, or `null` when no skill is available.
 *
 * The caller passes the resolved skill root.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
export interface AvailableSkillDescription {
  readonly description: string;
  readonly name: string;
}

export function formatAvailableSkillsSection(
  skills: readonly AvailableSkillDescription[],
  options: { readonly skillRoot: string },
): string | null {
  if (skills.length === 0) return null;
  return [
    "Available skills",
    "Listed skills are available in this run. Do not claim a listed skill is inaccessible unless activation or workspace inspection actually fails.",
    "If the user names a skill or the request clearly matches one of the descriptions below, call load_skill before proceeding.",
    "If multiple skills match, activate the minimal set that covers the task. After activation, follow the returned instructions instead of improvising around them.",
    "If activation fails, say so briefly and continue with the best available alternative.",
    `Skill files live under \`${options.skillRoot}/<skill>/\`.`,
    "When a loaded SKILL.md mentions sibling files such as `references/foo.md`, resolve them relative to the directory containing that specific SKILL.md.",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description} (path: ${options.skillRoot}/${skill.name}/SKILL.md)`),
  ].join("\n");
}
