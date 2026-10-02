/**
 * Which skills a conversation may be given: the release's built-in skills and the family's own.
 *
 * Exports:
 * - `skillGrantCatalog`: the built-in names and the family's working skills, each with whether it
 *   runs scripts (and so needs Bash in an external group).
 * - `grantableSkillNames`, `skillNeedsBash`, `requireGrantableSkills`: what a group's skill list is
 *   checked against.
 * - `SkillGrantCatalog`.
 *
 * A family skill that was disabled or deleted is simply not in the catalog: a group that still
 * lists it no longer receives it, and its other grants stay as they are.
 */
import { AppError } from "../app-error.js";
import { GROUP_SAFE_SKILL_NAMES, skillRequiresBash } from "../group-skills/group-skill-catalog.js";

export interface SkillGrantCatalog {
  readonly builtIn: ReadonlySet<string>;
  /** The family's working skills: whether each runs scripts. */
  readonly family: ReadonlyMap<string, { readonly executable: boolean }>;
}

/** `family`: the result of `workingFamilySkills` (`family-skill-repository.ts`). */
export function skillGrantCatalog(family: SkillGrantCatalog["family"]): SkillGrantCatalog {
  return { builtIn: new Set(GROUP_SAFE_SKILL_NAMES), family };
}

/** Built-in skills first, then the family's own, each list sorted. */
export function grantableSkillNames(catalog: SkillGrantCatalog): string[] {
  return [...catalog.builtIn, ...[...catalog.family.keys()].filter((name) => !catalog.builtIn.has(name)).sort()];
}

export function skillNeedsBash(catalog: SkillGrantCatalog, name: string): boolean {
  return catalog.builtIn.has(name) ? skillRequiresBash(name) : catalog.family.get(name)?.executable === true;
}

/** A skill list the owner sets for a group must name skills that exist and work now. */
export function requireGrantableSkills(catalog: SkillGrantCatalog, names: readonly string[]): void {
  const unknown = names.filter((name) => !catalog.builtIn.has(name) && !catalog.family.has(name));
  if (unknown.length > 0) {
    throw new AppError("AGENT_GROUP_SKILL_UNKNOWN",
      `Нет такого скилла среди встроенных и включённых скиллов семьи: ${unknown.join(", ")}. Проверьте список через manage_skill list`,
      { details: { unknown: unknown.join(",") } });
  }
}
