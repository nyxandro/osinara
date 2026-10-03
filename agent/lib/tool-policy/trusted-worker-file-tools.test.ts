/**
 * Trusted task-worker file boundary tests.
 *
 * Constructs covered:
 * - Every file operation repeats live trusted-workspace authorization.
 * - Paths stay inside currently authorized personal/family roots.
 * - Revoked access and symlink escapes fail before the built-in executor.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolDefinition } from "../../runtime/tool.js";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { createTrustedWorkerFileTools } from "./trusted-worker-file-tools.js";

const AUTHORIZATION = {
  familyId: "family-1",
  groupId: null,
  groupType: null,
  role: "owner" as const,
  telegramChatType: "private" as const,
  userId: "telegram:101",
};

function tool(execute: ReturnType<typeof vi.fn>): ToolDefinition<any, any> {
  return { description: "built-in default", execute, inputSchema: {} } as ToolDefinition<any, any>;
}

function context() {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            familyId: AUTHORIZATION.familyId,
            role: AUTHORIZATION.role,
            telegramChatType: AUTHORIZATION.telegramChatType,
          },
          authenticator: "telegram",
          principalId: AUTHORIZATION.userId,
          principalType: "user",
        },
        initiator: null,
      },
    },
  } as never;
}

describe("trusted worker file tools", () => {
  let familyRoot: string;
  let personalRoot: string;
  let authorize: Mock;
  let executors: Record<"glob" | "grep" | "read_file" | "write_file", ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    personalRoot = await mkdtemp(join(tmpdir(), "osinara-worker-personal-"));
    familyRoot = await mkdtemp(join(tmpdir(), "osinara-worker-family-"));
    await mkdir(join(personalRoot, "docs"));
    await writeFile(join(personalRoot, "docs", "allowed.txt"), "allowed\n");
    authorize = vi.fn(async (_auth: WorkspaceAuthorization) => [
      { hostRoot: personalRoot, mountPoint: "personal" as const },
      { hostRoot: familyRoot, mountPoint: "family" as const },
    ]);
    executors = {
      glob: vi.fn(async (input) => ({ input })),
      grep: vi.fn(async (input) => ({ input })),
      read_file: vi.fn(async (input) => ({ input })),
      write_file: vi.fn(async (input) => ({ input })),
    };
  });

  afterEach(async () => {
    await Promise.all([personalRoot, familyRoot].map((root) => rm(root, {
      force: true,
      recursive: true,
    })));
  });

  function tools() {
    return createTrustedWorkerFileTools({
      authorize,
      defaults: {
        glob: tool(executors.glob),
        grep: tool(executors.grep),
        read_file: tool(executors.read_file),
        write_file: tool(executors.write_file),
      },
    });
  }

  it.each([
    ["glob", { path: "/workspace/group", pattern: "**/*" }],
    ["grep", { path: "/tmp/home", pattern: "secret" }],
    ["read_file", { filePath: "/workspace/personal/../family/private.txt" }],
    ["write_file", { content: "escape", filePath: "/tools/personal/token" }],
  ] as const)("rejects a path outside authorized trusted mounts through %s", async (name, input) => {
    await expect(tools()[name]!.execute(input, context())).rejects.toThrowError(
      /AGENT_WORKER_FILE_PATH_FORBIDDEN/u,
    );
    expect(executors[name]).not.toHaveBeenCalled();
  });

  it("denies execution after live workspace access is revoked", async () => {
    authorize.mockRejectedValueOnce(
      new Error("AGENT_WORKSPACE_ACCESS_REVOKED: Доступ к workspace был отозван"),
    );

    await expect(tools().read_file!.execute(
      { filePath: "/workspace/personal/docs/allowed.txt" },
      context(),
    )).rejects.toThrowError(/AGENT_WORKSPACE_ACCESS_REVOKED/u);
    expect(executors.read_file).not.toHaveBeenCalled();
  });

  it("rejects symlink components before reading", async () => {
    const outside = await mkdtemp(join(tmpdir(), "osinara-worker-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(outside, join(personalRoot, "escape"));

    try {
      await expect(tools().read_file!.execute(
        { filePath: "/workspace/personal/escape/secret.txt" },
        context(),
      )).rejects.toThrowError(/AGENT_WORKER_FILE_PATH_FORBIDDEN/u);
      expect(executors.read_file).not.toHaveBeenCalled();
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("passes an authorized canonical path to the built-in executor", async () => {
    const ctx = context();
    await tools().read_file!.execute(
      { filePath: "/workspace/personal/docs/allowed.txt" },
      ctx,
    );

    expect(authorize).toHaveBeenCalledWith(AUTHORIZATION);
    expect(executors.read_file).toHaveBeenCalledWith(
      { filePath: "/workspace/personal/docs/allowed.txt" },
      ctx,
    );
  });
});
