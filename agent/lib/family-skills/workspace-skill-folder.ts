/**
 * A skill folder in a family member's workspace: the draft the agent prepares, read as a package.
 *
 * Exports:
 * - `readWorkspaceSkillFolder`: the package files under the folder, with paths relative to it.
 *   The workspace refuses symbolic links anywhere on the way. Service files (`.git`, caches) are
 *   left unread, and a folder over a family skill's limits is refused before any file is read.
 * - `writeWorkspaceSkillFolder`: makes a folder hold exactly the given files (a checkout of a
 *   skill's current version), removing what else it held.
 * - `skillManifest`: the `SKILL.md` text for a stored skill's name, description, license and body.
 *
 * The sandbox writes there: the agent writes a skill itself, or downloads one with `git`/`curl`
 * through the egress proxy, and `manage_skill` takes it from the folder.
 */
import type { SessionContext } from "../../runtime/context.js";
import {
  FAMILY_SKILL_LIMITS,
  isSkillServiceFile,
  requireWithinSkillLimits,
  type SkillPackageFile,
} from "../../runtime/skills/package-validation.js";
import { AppError } from "../app-error.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { WORKSPACES_ROOT } from "../workspaces/workspace-repository.js";
import type { WorkspaceScope } from "../workspaces/workspace-file-record.js";
import {
  deleteWorkspaceFile,
  listWorkspaceStoredFilesUnder,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../workspaces/workspace-storage.js";
import { validateWorkspacePath } from "../workspaces/workspace-path.js";

export async function readWorkspaceSkillFolder(
  ctx: Pick<SessionContext, "session">,
  input: { readonly path: string; readonly scope: WorkspaceScope },
): Promise<SkillPackageFile[]> {
  const folder = validateWorkspacePath(input.path.replace(/\/+$/u, ""));
  const workspaceId = await workspaceBinaryRepository.workspaceId(requireWorkspaceAuthorization(ctx), input.scope);
  const stored = (await listWorkspaceStoredFilesUnder(WORKSPACES_ROOT, workspaceId, folder))
    .filter((file) => !isSkillServiceFile(file.path.slice(folder.length + 1)));
  requireWithinSkillLimits(stored.map((file) => file.byteSize), FAMILY_SKILL_LIMITS);
  if (stored.length === 0) {
    throw new AppError("AGENT_SKILL_PACKAGE_INVALID", `Папка ${folder} пуста или не найдена в рабочей области`);
  }
  return await Promise.all(stored.map(async (file) => ({
    content: await readWorkspaceFile(WORKSPACES_ROOT, workspaceId, file.path),
    path: file.path.slice(folder.length + 1),
  })));
}

/** Values are JSON strings, which the front matter reader takes as quoted scalars. */
export function skillManifest(skill: {
  readonly description: string; readonly license: string | null; readonly markdown: string; readonly name: string;
}): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    ...(skill.license === null ? [] : [`license: ${JSON.stringify(skill.license)}`]),
    "---",
    "",
    skill.markdown,
  ].join("\n");
}

export async function writeWorkspaceSkillFolder(
  ctx: Pick<SessionContext, "session">,
  input: { readonly files: ReadonlyArray<{ readonly content: Uint8Array; readonly path: string }>; readonly path: string },
): Promise<void> {
  const folder = validateWorkspacePath(input.path.replace(/\/+$/u, ""));
  const workspaceId = await workspaceBinaryRepository.workspaceId(requireWorkspaceAuthorization(ctx), "personal");
  let existing: Awaited<ReturnType<typeof listWorkspaceStoredFilesUnder>> = [];
  try {
    existing = await listWorkspaceStoredFilesUnder(WORKSPACES_ROOT, workspaceId, folder);
  } catch (error) {
    // A folder that does not exist yet simply has nothing to remove.
    if (!(error instanceof AppError && error.code === "AGENT_WORKSPACE_FILE_NOT_FOUND")) throw error;
  }
  const kept = new Set(input.files.map((file) => `${folder}/${file.path}`));
  for (const file of existing.filter((stored) => !kept.has(stored.path))) {
    await deleteWorkspaceFile(WORKSPACES_ROOT, workspaceId, file.path);
  }
  for (const file of input.files) {
    await writeWorkspaceFile(WORKSPACES_ROOT, workspaceId, `${folder}/${file.path}`, file.content);
  }
}
