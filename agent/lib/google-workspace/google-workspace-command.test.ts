/**
 * Safe Google Workspace command boundary tests.
 *
 * Constructs covered:
 * - Structured service/resource/method values become argv without a shell.
 * - Auth/config commands, helper commands, and caller-controlled host paths are rejected.
 * - Read-only classification is conservative so every possible mutation requires HITL.
 */
import { access, writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  buildGoogleWorkspaceArguments,
  isGoogleWorkspaceReadOnlyCommand,
  runGoogleWorkspaceCommand,
} from "./google-workspace-command.js";

describe("Google Workspace command boundary", () => {
  it("builds bounded structured arguments for a paginated read", () => {
    expect(buildGoogleWorkspaceArguments({
      method: "list",
      pageAll: true,
      pageLimit: 4,
      params: JSON.stringify({ pageSize: 25, q: "name contains 'report'" }),
      resourcePath: ["files"],
      service: "drive",
    }, {})).toEqual([
      "drive",
      "files",
      "list",
      "--params",
      JSON.stringify({ pageSize: 25, q: "name contains 'report'" }),
      "--page-all",
      "--page-limit",
      "4",
      "--format",
      "json",
    ]);
  });

  it("uses only trusted temporary paths for upload and output", () => {
    const args = buildGoogleWorkspaceArguments({
      body: JSON.stringify({ name: "report.pdf" }),
      method: "create",
      resourcePath: ["files"],
      service: "drive",
      uploadContentType: "application/pdf",
    }, {
      outputPath: "/tmp/osinara-gws-random/download.bin",
      uploadPath: "/tmp/osinara-gws-random/upload.bin",
    });

    expect(args).toContain("/tmp/osinara-gws-random/upload.bin");
    expect(args).toContain("/tmp/osinara-gws-random/download.bin");
    expect(args).not.toContain("report.pdf");
  });

  it.each([
    { method: "list", resourcePath: ["files"], service: "auth" },
    { method: "+upload", resourcePath: ["files"], service: "drive" },
    { method: "list", resourcePath: ["--help"], service: "drive" },
    { method: "list", resourcePath: [], service: "drive" },
  ])("rejects unsafe command input %#", (command) => {
    expect(() => buildGoogleWorkspaceArguments(command as never, {})).toThrowError(
      /AGENT_GOOGLE_WORKSPACE_COMMAND_INVALID/,
    );
  });

  it.each([
    "not-json",
    "[]",
    "null",
  ])("rejects params that are not a JSON object: %s", (params) => {
    expect(() => buildGoogleWorkspaceArguments({
      method: "list",
      params,
      resourcePath: ["files"],
      service: "drive",
    }, {})).toThrowError(/AGENT_GOOGLE_WORKSPACE_COMMAND_JSON_INVALID/);
  });

  it("classifies only known bodyless reads as approval-free", () => {
    expect(isGoogleWorkspaceReadOnlyCommand({
      method: "get",
      resourcePath: ["files"],
      service: "drive",
    })).toBe(true);
    expect(isGoogleWorkspaceReadOnlyCommand({
      method: "create",
      resourcePath: ["files"],
      service: "drive",
    })).toBe(false);
    expect(isGoogleWorkspaceReadOnlyCommand({
      body: JSON.stringify({ addParents: "folder" }),
      method: "get",
      resourcePath: ["files"],
      service: "drive",
    })).toBe(false);
    expect(isGoogleWorkspaceReadOnlyCommand({
      method: "unknownFutureMethod",
      resourcePath: ["files"],
      service: "drive",
    })).toBe(false);
  });

  it("isolates the token and bridges files only through a private temporary directory", async () => {
    let workingDirectory = "";
    const runProcess = vi.fn(async (invocation: {
      args: string[];
      cwd: string;
      env: Record<string, string>;
    }) => {
      workingDirectory = invocation.cwd;
      expect(invocation.args).not.toContain("access-secret");
      expect(invocation.env).toEqual({
        GOOGLE_WORKSPACE_CLI_CONFIG_DIR: `${invocation.cwd}/config`,
        GOOGLE_WORKSPACE_CLI_TOKEN: "access-secret",
        HOME: invocation.cwd,
        NO_COLOR: "1",
      });
      const outputIndex = invocation.args.indexOf("--output");
      await writeFile(invocation.args[outputIndex + 1]!, Buffer.from("downloaded"));
      return { stderr: "", stdout: JSON.stringify({ id: "file-1" }) };
    });

    await expect(runGoogleWorkspaceCommand({
      method: "get",
      params: JSON.stringify({ alt: "media", fileId: "file-1" }),
      resourcePath: ["files"],
      service: "drive",
    }, "access-secret", {
      output: true,
      runProcess,
      upload: { bytes: Buffer.from("upload"), contentType: "text/plain" },
    })).resolves.toEqual({
      data: { id: "file-1" },
      outputBytes: Buffer.from("downloaded"),
    });
    expect(runProcess).toHaveBeenCalledOnce();
    await expect(access(workingDirectory)).rejects.toThrow();
  });
});
