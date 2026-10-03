/**
 * Skill definitions as the files a sandbox receives.
 *
 * Export:
 * - `toSkillPackage`: `SKILL.md` from the definition's markdown plus its extra files, sorted by
 *   path, with names and paths checked to stay inside the skill's own directory.
 *
 * Ported from eve 0.40.0 `shared/skill-package.ts` (`normalizeSkillPackage`) (Apache-2.0, see
 * NOTICE-eve). Texts of the errors are verbatim.
 */
import type { SandboxSkillPackage } from "../sandbox/types.js";
import type { SkillDefinition } from "./definition.js";

function assertSafeSkillPackageName(name: string): void {
  if (name.length === 0 || name.startsWith(".") || name.includes("/") || name.includes("\\") || name.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || /^[A-Za-z]:/u.test(name)) {
    throw new Error('Expected skill name to be a non-empty shell-safe path segment starting with an alphanumeric character and containing only alphanumerics, ".", "_", or "-".');
  }
}

function assertSafeSkillPackageFilePath(relativePath: string): void {
  if (relativePath === "SKILL.md") throw new Error('Skill package files must not include "SKILL.md"; eve generates it.');
  if (relativePath.length === 0 || relativePath.startsWith("/") || relativePath.includes("\\") || /^[A-Za-z]:/u.test(relativePath) ||
    relativePath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Expected skill package file paths to be relative POSIX paths.");
  }
}

export function toSkillPackage(name: string, skill: SkillDefinition): SandboxSkillPackage {
  assertSafeSkillPackageName(name);
  const files = [{ content: Buffer.from(skill.markdown, "utf8") as Uint8Array, relativePath: "SKILL.md" }];
  for (const [relativePath, content] of Object.entries(skill.files ?? {})) {
    assertSafeSkillPackageFilePath(relativePath);
    files.push({ content: typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content), relativePath });
  }
  files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  return { files, name };
}
