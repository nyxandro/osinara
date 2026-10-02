/**
 * Which skills a conversation may be given: the release's built-in skills and the family's own.
 *
 * Exports:
 * - `skillGrantCatalog`: the built-in names and the family's confirmed skills, each with whether it
 *   is enabled and whether it runs scripts (and so needs Bash in an external group).
 * - `grantableSkillNames`, `isWorkingSkill`, `skillNeedsBash`, `requireGrantableSkills`: what a
 *   group's skill list is checked against.
 * - `SkillGrantCatalog`.
 *
 * A disabled family skill stays grantable: a group that lists it does not receive it until the
 * owner enables it again, and the list can be saved unchanged meanwhile. A deleted one leaves the
 * catalog and the groups' lists together (`family-skill-repository.ts`).
 */
import { AppError } from "../app-error.js";
import { GROUP_SAFE_SKILL_NAMES, skillRequiresBash } from "../group-skills/group-skill-catalog.js";

export interface SkillGrantCatalog {
  readonly builtIn: ReadonlySet<string>;
  /** The family's confirmed skills: whether each is enabled and runs scripts. */
  readonly family: ReadonlyMap<string, { readonly enabled: boolean; readonly executable: boolean }>;
}

/** `family`: the result of `grantableFamilySkills` (`family-skill-repository.ts`). */
export function skillGrantCatalog(family: SkillGrantCatalog["family"]): SkillGrantCatalog {
  return { builtIn: new Set(GROUP_SAFE_SKILL_NAMES), family };
}

/** Built-in skills first, then the family's own, each list sorted. */
export function grantableSkillNames(catalog: SkillGrantCatalog): string[] {
  return [...catalog.builtIn, ...[...catalog.family.keys()].filter((name) => !catalog.builtIn.has(name)).sort()];
}

/** A skill a turn receives now: built in, or the family's and enabled. */
export function isWorkingSkill(catalog: SkillGrantCatalog, name: string): boolean {
  return catalog.builtIn.has(name) || catalog.family.get(name)?.enabled === true;
}

export function skillNeedsBash(catalog: SkillGrantCatalog, name: string): boolean {
  return catalog.builtIn.has(name) ? skillRequiresBash(name) : catalog.family.get(name)?.executable === true;
}

/** A skill list the owner sets for a group must name built-in skills or confirmed family skills. */
export function requireGrantableSkills(catalog: SkillGrantCatalog, names: readonly string[]): void {
  const unknown = names.filter((name) => !catalog.builtIn.has(name) && !catalog.family.has(name));
  if (unknown.length > 0) {
    throw new AppError("AGENT_GROUP_SKILL_UNKNOWN",
      `Нет такого скилла среди встроенных и подтверждённых скиллов семьи: ${unknown.join(", ")}. Проверьте список через manage_skill list`,
      { details: { unknown: unknown.join(",") } });
  }
}
