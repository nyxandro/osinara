/**
 * Execution-time filesystem boundary for the declared universal task worker.
 *
 * Exports:
 * - `createTrustedWorkerFileTools`: injectable same-name Eve wrappers for isolated tests.
 * - `TRUSTED_WORKER_FILE_TOOLS`: production wrappers with live personal/family authorization.
 */
import type { ToolDefinition } from "../../runtime/tool.js";
import {
  glob as eveGlob,
  grep as eveGrep,
  readFile as eveReadFile,
  writeFile as eveWriteFile,
} from "eve/tools/defaults";

import { AppError } from "../app-error.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { workspaceRepository } from "../workspaces/workspace-repository.js";
import {
  createScopedFileTools,
  type ScopedFileToolName,
  type ScopedWorkspaceRoot,
} from "./scoped-file-tools.js";

type AnyToolDefinition = ToolDefinition<any, any>;

interface TrustedWorkerFileToolDependencies {
  authorize(auth: WorkspaceAuthorization): Promise<readonly ScopedWorkspaceRoot[]>;
  defaults: Readonly<Record<ScopedFileToolName, AnyToolDefinition>>;
}

function forbiddenPath(): AppError {
  return new AppError(
    "AGENT_WORKER_FILE_PATH_FORBIDDEN",
    "Файловая операция worker разрешена только внутри текущего personal или family workspace",
  );
}

export function createTrustedWorkerFileTools(
  dependencies: TrustedWorkerFileToolDependencies,
): Readonly<Record<ScopedFileToolName, AnyToolDefinition>> {
  return createScopedFileTools({
    authorize: dependencies.authorize,
    defaults: dependencies.defaults,
    forbiddenPath,
  });
}

export const TRUSTED_WORKER_FILE_TOOLS = createTrustedWorkerFileTools({
  authorize: async (auth) => await workspaceRepository.trustedRoots(auth),
  defaults: {
    glob: eveGlob,
    grep: eveGrep,
    read_file: eveReadFile,
    write_file: eveWriteFile,
  },
});
