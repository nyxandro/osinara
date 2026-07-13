/**
 * Workspace path validation.
 *
 * Export:
 * - `validateWorkspacePath`: requires a canonical relative POSIX file path.
 */
import { AppError } from "../app-error.js";

const WORKSPACE_PATH_MAX_CHARACTERS = 512;

export function validateWorkspacePath(path: string): string {
  const segments = path.split("/");
  const invalid = path.length === 0 ||
    path.length > WORKSPACE_PATH_MAX_CHARACTERS ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (invalid) {
    throw new AppError(
      "AGENT_WORKSPACE_PATH_INVALID",
      "Путь файла должен быть относительным и не может выходить за пределы workspace",
    );
  }
  return path;
}
