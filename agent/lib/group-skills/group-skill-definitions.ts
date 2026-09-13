/** One installed skill catalog for all conversation modes, outside static Eve discovery. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineSkill, type SkillDefinition, type SkillFileContent } from "eve/skills";
import { AppError } from "../app-error.js";
import { GROUP_SAFE_SKILL_NAMES, SKILL_CATALOG_ROOT, type GroupSafeSkillName } from "./group-skill-catalog.js";
import { GOOGLE_WORKSPACE_EXECUTION_GUIDE } from "../google-workspace/google-workspace-skill-instructions.js";

function loadSkill(name: string): SkillDefinition {
  const root = join(SKILL_CATALOG_ROOT, name);
  const source = readFileSync(join(root, "SKILL.md"), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source);
  const rawDescription = frontmatter?.[1].match(/^description:\s*(.+)$/mu)?.[1].trim();
  const declaredName = frontmatter?.[1].match(/^name:\s*(.+)$/mu)?.[1].trim();
  if (!frontmatter || !rawDescription || [">", "|"].includes(rawDescription) || (declaredName && declaredName !== name)) {
    throw new AppError("AGENT_SKILL_PACKAGE_INVALID", `Повреждён установленный пакет скилла ${name}`);
  }
  const description: unknown = rawDescription.startsWith('"') ? JSON.parse(rawDescription) : rawDescription;
  if (typeof description !== "string" || !description.trim()) {
    throw new AppError("AGENT_SKILL_PACKAGE_INVALID", `Не задано описание скилла ${name}`);
  }
  const files: Record<string, SkillFileContent> = {};
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new AppError("AGENT_SKILL_PACKAGE_INVALID", `Скилл ${name} содержит символическую ссылку`);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && path !== "SKILL.md") files[path] = readFileSync(join(root, path));
    }
  }
  const license = frontmatter[1].match(/^license:\s*(.+)$/mu)?.[1].trim();
  const markdown = name.startsWith("gws-")
    ? `${GOOGLE_WORKSPACE_EXECUTION_GUIDE}\n\n${frontmatter[2].trimStart()}`
    : frontmatter[2].trimStart();
  return defineSkill({ description, markdown, files, ...(license ? { license } : {}) });
}

export const GROUP_SAFE_SKILL_DEFINITIONS: Readonly<Record<GroupSafeSkillName, SkillDefinition>> =
  Object.fromEntries(GROUP_SAFE_SKILL_NAMES.map((name) => [name, loadSkill(name)]));

export function selectGroupSafeSkillDefinitions(names: ReadonlySet<GroupSafeSkillName>): Record<string, SkillDefinition> {
  return Object.fromEntries([...names].map((name) => {
    const definition = GROUP_SAFE_SKILL_DEFINITIONS[name];
    if (!definition) throw new AppError("AGENT_GROUP_SKILL_FORBIDDEN", "Этот скилл не установлен в приложении");
    return [name, definition];
  }));
}
