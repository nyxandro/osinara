/**
 * The release's built-in skills, read once from `config/skills/` at process start.
 *
 * Export:
 * - `GROUP_SAFE_SKILL_DEFINITIONS`: every built-in skill by name, checked by the same rules as a
 *   family's own skill (`validateSkillPackage`), without the family size limits.
 *
 * A broken built-in package stops the process at start: it is the release's own content.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { defineSkill, type SkillDefinition } from "../../runtime/skills/definition.js";
import { isSkillServiceFile, validateSkillPackage, type SkillPackageFile } from "../../runtime/skills/package-validation.js";
import { AppError } from "../app-error.js";
import { GOOGLE_WORKSPACE_EXECUTION_GUIDE } from "../google-workspace/google-workspace-skill-instructions.js";
import { GROUP_SAFE_SKILL_NAMES, SKILL_CATALOG_ROOT, type GroupSafeSkillName } from "./group-skill-catalog.js";

function readPackageFiles(name: string): SkillPackageFile[] {
  const root = join(SKILL_CATALOG_ROOT, name);
  const files: SkillPackageFile[] = [];
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (isSkillServiceFile(path)) continue;
      if (entry.isSymbolicLink()) {
        throw new AppError("AGENT_SKILL_PACKAGE_INVALID", `Скилл ${name} содержит символическую ссылку`);
      }
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push({ content: readFileSync(join(root, path)), path });
    }
  }
  return files;
}

function loadSkill(name: string): SkillDefinition {
  const validated = validateSkillPackage({ expectedName: name, files: readPackageFiles(name), limits: null });
  const markdown = name.startsWith("gws-")
    ? `${GOOGLE_WORKSPACE_EXECUTION_GUIDE}\n\n${validated.markdown}`
    : validated.markdown;
  return defineSkill({
    description: validated.description,
    files: Object.fromEntries(validated.files.map((file) => [file.path, file.content])),
    markdown,
    ...(validated.license ? { license: validated.license } : {}),
  });
}

export const GROUP_SAFE_SKILL_DEFINITIONS: Readonly<Record<GroupSafeSkillName, SkillDefinition>> =
  Object.fromEntries(GROUP_SAFE_SKILL_NAMES.map((name) => [name, loadSkill(name)]));
