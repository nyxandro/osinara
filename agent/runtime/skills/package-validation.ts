/**
 * Checking a skill package before anyone may use it.
 *
 * Exports:
 * - `validateSkillPackage`: a package's files into its name, description, `SKILL.md` body and
 *   other files, or an `AGENT_SKILL_PACKAGE_INVALID` error that says what is wrong.
 * - `SKILL_NAME_PATTERN`, `FAMILY_SKILL_LIMITS`: what a skill name may be, and the size limits a
 *   family's own skill must fit (it is copied into the sandbox on every turn).
 * - `isSkillServiceFile`, `requireWithinSkillLimits`: the same skipping and count/total limits for a
 *   reader that checks a folder before reading its files.
 * - `SkillPackageFile`, `ValidatedSkillPackage`.
 *
 * The same rules hold for the release's built-in skills and a family's own: `SKILL.md` with
 * `name` and `description`, no symbolic links (the readers refuse them), service files skipped.
 */
import { createHash } from "node:crypto";

import { AppError } from "../../lib/app-error.js";
import { parseSkillFrontmatter } from "./frontmatter.js";

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

// The description goes into the system prompt of every turn, so it is one bounded line.
export const FAMILY_SKILL_LIMITS = Object.freeze({
  maxDescriptionCharacters: 1024,
  maxFileBytes: 1024 * 1024,
  maxFiles: 100,
  maxTotalBytes: 2 * 1024 * 1024,
});

const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|mts|cts|rb|pl|php|lua|ps1|r|tcl|jar|go)$/iu;
const SCRIPT_NAMES = new Set(["Makefile", "makefile", "GNUmakefile", "Rakefile", "justfile"]);

export interface SkillPackageFile {
  readonly content: Uint8Array;
  /** Relative POSIX path inside the package. */
  readonly path: string;
}

export interface ValidatedSkillPackage {
  readonly contentHash: string;
  readonly description: string;
  readonly files: ReadonlyArray<SkillPackageFile & { readonly executable: boolean; readonly size: number }>;
  readonly license?: string;
  /** The `SKILL.md` body after its frontmatter. */
  readonly markdown: string;
  readonly name: string;
}

function invalid(message: string, details?: Readonly<Record<string, string | number>>): AppError {
  return new AppError("AGENT_SKILL_PACKAGE_INVALID", message, details === undefined ? undefined : { details });
}

export function isSkillServiceFile(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(".") || segment === "__pycache__") || path.endsWith(".pyc");
}

function isExecutable(path: string, content: Uint8Array): boolean {
  const head = Buffer.from(content.subarray(0, 4));
  return SCRIPT_EXTENSIONS.test(path) || SCRIPT_NAMES.has(path.slice(path.lastIndexOf("/") + 1)) ||
    head.subarray(0, 2).toString("latin1") === "#!" || head.toString("latin1") === "\u007fELF";
}

function requireSafePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw invalid(`Недопустимый путь файла в скилле: ${path}`);
  }
}

/** `sizes`: byte sizes of the package's files, service files already skipped. */
export function requireWithinSkillLimits(sizes: readonly number[], limits: typeof FAMILY_SKILL_LIMITS): void {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const largest = sizes.reduce((max, size) => Math.max(max, size), 0);
  if (sizes.length > limits.maxFiles) throw invalid(`В скилле больше ${limits.maxFiles} файлов`, { files: sizes.length });
  if (largest > limits.maxFileBytes) throw invalid("Один из файлов скилла больше 1 МБ", { largest });
  if (total > limits.maxTotalBytes) throw invalid("Скилл вместе со всеми файлами больше 2 МБ", { total });
}

export function validateSkillPackage(input: {
  /** A built-in skill is named by its folder; a declared `name` must agree with it. */
  readonly expectedName?: string;
  readonly files: readonly SkillPackageFile[];
  readonly limits: typeof FAMILY_SKILL_LIMITS | null;
}): ValidatedSkillPackage {
  // Paths are checked before service files are skipped: `..` must be refused, not skipped as hidden.
  for (const file of input.files) requireSafePath(file.path);
  const files = input.files.filter((file) => !isSkillServiceFile(file.path));
  const manifest = files.find((file) => file.path === "SKILL.md");
  if (manifest === undefined) throw invalid("В папке скилла нет файла SKILL.md");
  let frontmatter: ReturnType<typeof parseSkillFrontmatter>;
  try {
    frontmatter = parseSkillFrontmatter(Buffer.from(manifest.content).toString("utf8"));
  } catch (error) {
    throw new AppError("AGENT_SKILL_PACKAGE_INVALID", "Заголовок SKILL.md не читается", { cause: error });
  }
  if (frontmatter === null) throw invalid("SKILL.md должен начинаться с заголовка между строками ---");
  const declared = frontmatter.fields.name?.trim();
  const name = declared || input.expectedName;
  if (!name || !SKILL_NAME_PATTERN.test(name)) {
    throw invalid("Имя скилла должно состоять из строчных латинских букв, цифр и дефисов, до 63 символов");
  }
  if (input.expectedName !== undefined && name !== input.expectedName) {
    throw invalid(`Имя в SKILL.md (${name}) не совпадает с папкой скилла (${input.expectedName})`);
  }
  const declaredDescription = frontmatter.fields.description?.trim();
  if (!declaredDescription) throw invalid(`В SKILL.md скилла ${name} нет описания (description)`);
  // A family's package is untrusted: line breaks and control characters could forge prompt sections.
  const description = input.limits === null
    ? declaredDescription
    : declaredDescription.replace(/[\p{Cc}\p{Cf}\u2028\u2029\s]+/gu, " ").trim();
  if (input.limits !== null && description.length > input.limits.maxDescriptionCharacters) {
    throw invalid(`Описание скилла в SKILL.md длиннее ${input.limits.maxDescriptionCharacters} знаков: сократите его`, {
      characters: description.length,
    });
  }

  const others = files.filter((file) => file.path !== "SKILL.md")
    .map((file) => ({ ...file, executable: isExecutable(file.path, file.content), size: file.content.byteLength }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (input.limits !== null) requireWithinSkillLimits(files.map((file) => file.content.byteLength), input.limits);
  const hash = createHash("sha256");
  for (const file of [manifest, ...others]) hash.update(file.path).update("\0").update(file.content).update("\0");
  return {
    contentHash: hash.digest("hex"),
    description,
    files: others,
    ...(frontmatter.fields.license ? { license: frontmatter.fields.license.trim() } : {}),
    markdown: frontmatter.body.trimStart(),
    name,
  };
}
