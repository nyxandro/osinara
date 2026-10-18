/**
 * The release's service skill for family members: how to find, write, save and fix the family's skills.
 *
 * Exports:
 * - `SKILL_MANAGER_NAME`, `isServiceSkillName`: the reserved name; a family skill cannot take it.
 * - `SERVICE_SKILL_DEFINITIONS`: read once from `config/service-skills/` at process start, checked
 *   by the same rules as any other skill. A broken package stops the process at start.
 *
 * It is not a built-in skill: no group list may name it, and only a family member's private chat
 * gets it (`group-skill-resolver.ts`), because only there can skills be changed.
 */
import { resolve } from "node:path";

import { defineSkill, type SkillDefinition } from "../../runtime/skills/definition.js";
import { validateSkillPackage } from "../../runtime/skills/package-validation.js";
import { readSkillPackageFiles } from "../group-skills/group-skill-definitions.js";

export const SKILL_MANAGER_NAME = "skill-manager";
const SERVICE_SKILL_ROOT = resolve("config/service-skills");

export function isServiceSkillName(name: string): boolean {
  return name === SKILL_MANAGER_NAME;
}

function loadServiceSkill(name: string): SkillDefinition {
  const validated = validateSkillPackage({ expectedName: name, files: readSkillPackageFiles(SERVICE_SKILL_ROOT, name), limits: null });
  return defineSkill({
    description: validated.description,
    files: Object.fromEntries(validated.files.map((file) => [file.path, file.content])),
    markdown: validated.markdown,
  });
}

export const SERVICE_SKILL_DEFINITIONS: Readonly<Record<string, SkillDefinition>> = {
  [SKILL_MANAGER_NAME]: loadServiceSkill(SKILL_MANAGER_NAME),
};
