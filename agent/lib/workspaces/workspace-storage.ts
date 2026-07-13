/**
 * Persistent workspace filesystem boundary.
 *
 * Exports:
 * - `workspaceDirectory`: maps an opaque workspace ID to its physical directory.
 * - `getWorkspaceStoredFile`: reads trusted filesystem metadata for one confined path.
 * - `listWorkspaceStoredFiles`: recursively discovers regular files without an external index.
 * - `readWorkspaceFile`, `writeWorkspaceFile`, `deleteWorkspaceFile`: confined file I/O.
 */
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { WORKSPACE_MAX_FILE_BYTES } from "../../config.js";
import { AppError } from "../app-error.js";
import { validateWorkspacePath } from "./workspace-path.js";

export function workspaceDirectory(root: string, workspaceId: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(workspaceId)) {
    throw new AppError("AGENT_WORKSPACE_ID_INVALID", "Идентификатор workspace некорректен");
  }
  return join(root, workspaceId);
}

export interface WorkspaceStoredFile {
  byteSize: number;
  path: string;
  updatedAt: Date;
}

async function physicalPath(
  root: string,
  workspaceId: string,
  path: string,
  allowMissing: boolean,
): Promise<string> {
  const directory = workspaceDirectory(root, workspaceId);
  const safePath = validateWorkspacePath(path);
  const segments = safePath.split("/");
  let current = directory;

  // Every existing segment is checked because an intermediate symlink can escape the scope root.
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) {
        return join(current, ...segments.slice(index + 1));
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError("AGENT_WORKSPACE_FILE_NOT_FOUND", "Файл не найден в выбранном workspace");
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new AppError("AGENT_WORKSPACE_SYMLINK_FORBIDDEN", "Символические ссылки запрещены в workspace");
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new AppError("AGENT_WORKSPACE_PATH_INVALID", "Путь внутри workspace проходит через обычный файл");
    }
    if (index === segments.length - 1 && metadata.isDirectory()) {
      throw new AppError("AGENT_WORKSPACE_PATH_INVALID", "Путь должен указывать на обычный файл");
    }
  }
  return current;
}

async function scanWorkspaceDirectory(
  directory: string,
  current = directory,
): Promise<WorkspaceStoredFile[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: WorkspaceStoredFile[] = [];
  for (const entry of entries) {
    if (entry.name.includes(".osinara-") && entry.name.endsWith(".tmp")) continue;
    const target = join(current, entry.name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      throw new AppError("AGENT_WORKSPACE_SYMLINK_FORBIDDEN", "Символические ссылки запрещены в workspace");
    }
    if (metadata.isDirectory()) {
      files.push(...await scanWorkspaceDirectory(directory, target));
      continue;
    }
    if (!metadata.isFile()) continue;
    files.push({
      byteSize: metadata.size,
      path: relative(directory, target).split(sep).join("/"),
      updatedAt: metadata.mtime,
    });
  }
  return files;
}

export async function listWorkspaceStoredFiles(
  root: string,
  workspaceId: string,
): Promise<WorkspaceStoredFile[]> {
  const files = await scanWorkspaceDirectory(workspaceDirectory(root, workspaceId));
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function getWorkspaceStoredFile(
  root: string,
  workspaceId: string,
  path: string,
): Promise<WorkspaceStoredFile> {
  const safePath = validateWorkspacePath(path);
  const metadata = await lstat(await physicalPath(root, workspaceId, safePath, false));
  if (!metadata.isFile()) {
    throw new AppError("AGENT_WORKSPACE_FILE_NOT_FOUND", "Путь не указывает на обычный файл");
  }
  return { byteSize: metadata.size, path: safePath, updatedAt: metadata.mtime };
}

export async function readWorkspaceFile(
  root: string,
  workspaceId: string,
  path: string,
): Promise<Buffer> {
  try {
    const content = await readFile(await physicalPath(root, workspaceId, path, false));
    if (content.byteLength > WORKSPACE_MAX_FILE_BYTES) {
      throw new AppError("AGENT_WORKSPACE_FILE_TOO_LARGE", "Файл превышает допустимый размер 50 МБ");
    }
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new AppError("AGENT_WORKSPACE_FILE_NOT_FOUND", "Файл не найден в выбранном workspace");
  }
}

export async function writeWorkspaceFile(
  root: string,
  workspaceId: string,
  path: string,
  content: Uint8Array,
): Promise<void> {
  if (content.byteLength > WORKSPACE_MAX_FILE_BYTES) {
    throw new AppError("AGENT_WORKSPACE_FILE_TOO_LARGE", "Файл превышает допустимый размер 50 МБ");
  }
  const target = await physicalPath(root, workspaceId, path, true);
  await mkdir(dirname(target), { recursive: true });

  // Rename makes readers observe either the old complete file or the new complete file.
  const temporary = `${target}.osinara-${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx" });
  try {
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function deleteWorkspaceFile(
  root: string,
  workspaceId: string,
  path: string,
): Promise<boolean> {
  let target: string;
  try {
    target = await physicalPath(root, workspaceId, path, false);
  } catch (error) {
    if (error instanceof AppError && error.code === "AGENT_WORKSPACE_FILE_NOT_FOUND") return false;
    throw error;
  }
  await rm(target);
  return true;
}

export async function clearWorkspaceDirectory(root: string, workspaceId: string): Promise<void> {
  const directory = workspaceDirectory(root, workspaceId);
  await rm(directory, { force: true, recursive: true });
  await rm(join(root, ".derived", workspaceId), { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
}

export async function deleteWorkspaceDirectory(root: string, workspaceId: string): Promise<void> {
  await rm(workspaceDirectory(root, workspaceId), { force: true, recursive: true });
  await rm(join(root, ".derived", workspaceId), { force: true, recursive: true });
}
