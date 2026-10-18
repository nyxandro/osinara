/**
 * The skill list the model sees at the end of the system prompt.
 *
 * Export:
 * - `formatAvailableSkillsSection`: activation rules plus one line per skill, or `null` when no
 *   skill is available.
 *
 * The list needs no sandbox: a skill's files reach it only when the model loads that skill.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
export interface AvailableSkillDescription {
  readonly description: string;
  readonly name: string;
}

export function formatAvailableSkillsSection(skills: readonly AvailableSkillDescription[]): string | null {
  if (skills.length === 0) return null;
  return [
    "Available skills",
    "Listed skills are available in this run. Do not claim a listed skill is inaccessible unless activation or workspace inspection actually fails.",
    "If the user names a skill or the request clearly matches one of the descriptions below, call load_skill before proceeding.",
    "If multiple skills match, activate the minimal set that covers the task. After activation, follow the returned instructions instead of improvising around them.",
    "If activation fails, say so briefly and continue with the best available alternative.",
    "A skill's files, if it has any, are placed under `$HOME/.agents/skills/<skill>/` when you load it: load the skill before using its files, and resolve sibling paths such as `references/foo.md` relative to that directory. Anything else under `$HOME/.agents/skills/` is not a skill of this run.",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n");
}
