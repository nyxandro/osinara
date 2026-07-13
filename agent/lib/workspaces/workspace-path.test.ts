/**
 * Workspace path policy tests.
 *
 * Construct covered:
 * - `validateWorkspacePath`: canonical relative POSIX paths without traversal or aliases.
 */
import { describe, expect, it } from "vitest";

import { validateWorkspacePath } from "./workspace-path.js";

describe("validateWorkspacePath", () => {
  it("accepts a canonical nested relative path", () => {
    expect(validateWorkspacePath("documents/план.txt")).toBe("documents/план.txt");
  });

  it.each(["", "/etc/passwd", "../secret", "a/../secret", "a//b", "a\\b", ".hidden/./x"])(
    "rejects unsafe or non-canonical path %s",
    (path) => expect(() => validateWorkspacePath(path)).toThrowError(/AGENT_WORKSPACE_PATH_INVALID/),
  );
});
