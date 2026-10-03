/**
 * The release's built-in skills, and the skill lists Telegram groups hold.
 *
 * Exports:
 * - `GROUP_SAFE_SKILL_NAMES`, `isGroupSafeSkillName`: the code-reviewed built-in skills.
 * - `GroupSafeSkillName`: a skill name a group's list may hold — a built-in skill or one of the
 *   family's own (`family-skills/`).
 * - `parseGroupSkillAllowlist`: fail-closed persisted-policy parser: a malformed or duplicate name
 *   rejects the whole list; whether a name still exists is decided when skills are given out.
 * - `skillRequiresBash`: built-in skills that run scripts.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { SKILL_NAME_PATTERN } from "../../runtime/skills/package-validation.js";

export const SKILL_CATALOG_ROOT = resolve("config/skills");
const installedNames = readdirSync(SKILL_CATALOG_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (installedNames.length === 0 || installedNames.some((name) => !/^[a-z0-9][a-z0-9-]*$/u.test(name))) {
  throw new Error("AGENT_SKILL_CATALOG_INVALID: Каталог установленных скиллов пуст или повреждён");
}
export const GROUP_SAFE_SKILL_NAMES = Object.freeze(installedNames) as readonly [string, ...string[]];

export type GroupSafeSkillName = string;

// Executable skill dependencies are owner-visible and saved with the group's tool policy.
const BASH_SKILLS = new Set(["agent-browser", "docx", "pdf", "xlsx", "t-invest", "find-docs"]);
export function skillRequiresBash(name: string): boolean { return BASH_SKILLS.has(name); }

export function isGroupSafeSkillName(value: string): boolean {
  return (GROUP_SAFE_SKILL_NAMES as readonly string[]).includes(value);
}

export function parseGroupSkillAllowlist(
  value: unknown,
): ReadonlySet<GroupSafeSkillName> | null {
  if (!Array.isArray(value)) return null;

  // Malformed and duplicate grants indicate corrupt policy rather than a safe partial allowlist.
  const allowed = new Set<GroupSafeSkillName>();
  for (const name of value) {
    if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name) || allowed.has(name)) return null;
    allowed.add(name);
  }
  return allowed;
}
