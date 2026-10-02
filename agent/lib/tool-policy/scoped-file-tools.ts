/**
 * Shared execution-time boundary for Eve filesystem tools.
 *
 * Exports:
 * - `ScopedFileToolName`, `ScopedWorkspaceRoot`: contracts for authorized mount roots.
 * - `throwFileToolExecutionError`: shared safe normalization for native file failures.
 * - `createScopedFileTools`: same-name wrappers with live authorization and symlink confinement.
 */
import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";

import type { ToolContext, ToolDefinition } from "../../runtime/tool.js";
import { defineTool } from "../../runtime/tool.js";

import { isAppError, type AppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";

type AnyToolDefinition = ToolDefinition<any, any>;
export type ScopedFileToolName = "glob" | "grep" | "read_file" | "write_file";

export interface ScopedWorkspaceRoot {
  hostRoot: string;
  mountPoint: "family" | "group" | "personal";
}

interface ScopedFileToolDependencies {
  authorize(auth: WorkspaceAuthorization): Promise<readonly ScopedWorkspaceRoot[]>;
  defaultMountPoint?: ScopedWorkspaceRoot["mountPoint"];
  defaults: Readonly<Record<ScopedFileToolName, AnyToolDefinition>>;
  forbiddenPath(): AppError;
}

const SANDBOX_WORKSPACE_ROOT = "/workspace";
const FILE_PATH_MAX_CHARACTERS = 4_096;

function canonicalScopedPath(
  roots: readonly ScopedWorkspaceRoot[],
  value: unknown,
  defaultMountPoint: ScopedWorkspaceRoot["mountPoint"] | undefined,
  forbiddenPath: () => AppError,
): { hostRoot: string; relativePath: string; sandboxPath: string } {
  const defaultPath = defaultMountPoint === undefined
    ? undefined
    : `${SANDBOX_WORKSPACE_ROOT}/${defaultMountPoint}`;
  const path = value ?? defaultPath;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > FILE_PATH_MAX_CHARACTERS ||
    path.includes("\0") ||
    posix.normalize(path) !== path
  ) {
    throw forbiddenPath();
  }

  // Match the exact authorized mount prefix before deriving any relative host path.
  const root = roots.find(({ mountPoint }) => {
    const sandboxRoot = `${SANDBOX_WORKSPACE_ROOT}/${mountPoint}`;
    return path === sandboxRoot || path.startsWith(`${sandboxRoot}/`);
  });
  if (!root) throw forbiddenPath();
  const sandboxRoot = `${SANDBOX_WORKSPACE_ROOT}/${root.mountPoint}`;
  return {
    hostRoot: root.hostRoot,
    relativePath: path === sandboxRoot ? "" : path.slice(sandboxRoot.length + 1),
    sandboxPath: path,
  };
}

async function assertNoSymlinkComponent(
  hostRoot: string,
  relativePath: string,
  forbiddenPath: () => AppError,
): Promise<void> {
  const components = relativePath === "" ? [] : relativePath.split("/");
  let current = hostRoot;
  const rootMetadata = await lstat(hostRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw forbiddenPath();

  // Missing suffixes are valid writes; every existing ancestor must remain inside the volume root.
  for (const component of components) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw forbiddenPath();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function throwFileToolExecutionError(error: unknown, toolName: ScopedFileToolName): never {
  if (isAppError(error)) throw error;
  const isWrite = toolName === "write_file";
  console.error(JSON.stringify({
    code: "AGENT_FILE_TOOL_EXECUTION_FAILED",
    error: error instanceof Error ? error.message : String(error),
    toolName,
  }));
  throw new ModelFacingError({
    category: "dependency",
    code: "AGENT_FILE_TOOL_EXECUTION_FAILED",
    correction: isWrite
      ? "Не повторяйте запись автоматически: состояние файла неизвестно. Сначала прочитайте файл или найдите его через glob."
      : "Проверьте путь через glob и повторите read-only вызов один раз с существующим canonical path.",
    reason: `Файловая операция ${toolName} завершилась с внутренней ошибкой.`,
    retryable: !isWrite,
    sideEffectStatus: isWrite ? "unknown" : "not_started",
  });
}

async function withAuthorizedPath<T>(
  dependencies: ScopedFileToolDependencies,
  ctx: ToolContext,
  toolName: ScopedFileToolName,
  modelPath: unknown,
  operation: (sandboxPath: string) => Promise<T>,
): Promise<T> {
  const authorization = requireWorkspaceAuthorization(ctx);
  const roots = await dependencies.authorize(authorization);
  const path = canonicalScopedPath(
    roots,
    modelPath,
    dependencies.defaultMountPoint,
    dependencies.forbiddenPath,
  );
  try {
    await assertNoSymlinkComponent(path.hostRoot, path.relativePath, dependencies.forbiddenPath);
    return await operation(path.sandboxPath);
  } catch (error) {
    throwFileToolExecutionError(error, toolName);
  }
}

export function createScopedFileTools(
  dependencies: ScopedFileToolDependencies,
): Readonly<Record<ScopedFileToolName, AnyToolDefinition>> {
  return {
    glob: defineTool({
      ...dependencies.defaults.glob,
      async execute(input, ctx) {
        return await withAuthorizedPath(
          dependencies,
          ctx,
          "glob",
          (input as { path?: unknown }).path,
          async (path) => await dependencies.defaults.glob.execute({ ...input, path }, ctx),
        );
      },
    }),
    grep: defineTool({
      ...dependencies.defaults.grep,
      async execute(input, ctx) {
        return await withAuthorizedPath(
          dependencies,
          ctx,
          "grep",
          (input as { path?: unknown }).path,
          async (path) => await dependencies.defaults.grep.execute({ ...input, path }, ctx),
        );
      },
    }),
    read_file: defineTool({
      ...dependencies.defaults.read_file,
      async execute(input, ctx) {
        return await withAuthorizedPath(
          dependencies,
          ctx,
          "read_file",
          (input as { filePath?: unknown }).filePath,
          async (filePath) => await dependencies.defaults.read_file.execute({ ...input, filePath }, ctx),
        );
      },
    }),
    write_file: defineTool({
      ...dependencies.defaults.write_file,
      async execute(input, ctx) {
        return await withAuthorizedPath(
          dependencies,
          ctx,
          "write_file",
          (input as { filePath?: unknown }).filePath,
          async (filePath) => await dependencies.defaults.write_file.execute({ ...input, filePath }, ctx),
        );
      },
    }),
  };
}
