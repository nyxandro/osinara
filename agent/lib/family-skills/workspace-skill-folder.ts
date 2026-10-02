/**
 * A skill folder the agent prepared in the owner's workspace, read as a package.
 *
 * Export:
 * - `readWorkspaceSkillFolder`: the package files under the folder, with paths relative to it.
 *   The workspace refuses symbolic links anywhere on the way. Service files (`.git`, caches) are
 *   left unread, and a folder over a family skill's limits is refused before any file is read.
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
import { listWorkspaceStoredFilesUnder, readWorkspaceFile } from "../workspaces/workspace-storage.js";
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
