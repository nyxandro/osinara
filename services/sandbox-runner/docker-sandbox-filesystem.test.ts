/**
 * Docker sandbox filesystem bridge tests.
 *
 * Constructs covered:
 * - Reads stage files outside tmpfs before using Docker's archive API.
 * - Writes stage archives outside tmpfs before moving files in-container.
 * - Failed file commits retain the original error and observe cleanup failures.
 */
import { PassThrough } from "node:stream";

import type Docker from "dockerode";
import tar from "tar-stream";
import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";

const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const runtime = {
  egressNetwork: "osinara_sandbox-egress",
  image: "osinara-sandbox-runtime:local",
  project: "osinara",
  toolsVolume: "osinara_tool-environments",
  workspaceVolume: "osinara_workspace-data",
};

function successfulExec(source = new PassThrough()) {
  return {
    inspect: vi.fn(async () => ({ ExitCode: 0, Running: false })),
    start: vi.fn(async () => source),
  };
}

function createEngine(docker: Docker) {
  return createDockerSandboxEngine({
    docker,
    roots: {
      toolsRoot: "/tools",
      workspaceRoot: "/workspaces",
    },
    runtime,
  });
}

function archiveFile(name: string, content: string): NodeJS.ReadableStream {
  const pack = tar.pack();
  pack.entry({ name, type: "file" }, content);
  pack.finalize();
  return pack;
}

describe("Docker sandbox filesystem bridge", () => {
  it("stages a hidden-home read outside tmpfs before using the archive API", async () => {
    const container = {
      exec: vi.fn(async () => successfulExec()),
      getArchive: vi.fn(async () => archiveFile("staged", "skill instructions")),
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
    };
    const docker = {
      getContainer: vi.fn(() => container),
      modem: {
        demuxStream: vi.fn((_stream, stdout, stderr) => {
          stdout.end();
          stderr.end();
        }),
      },
    } as unknown as Docker;

    const content = await createEngine(docker).readFile(
      SANDBOX_SESSION_ID,
      "/tmp/home/.agents/skills/behavior-preferences/SKILL.md",
    );

    expect(new TextDecoder().decode(content)).toBe("skill instructions");
    expect(container.getArchive).toHaveBeenCalledWith({
      path: expect.stringMatching(/^\/\.osinara-sandbox-uploads\//u),
    });
    const commands = container.exec.mock.calls.map(([options]) => options.Cmd.at(-1));
    expect(commands).toEqual([
      expect.stringMatching(/^mkdir -p -- .* && .*cp -T -- .*SKILL\.md/u),
      expect.stringMatching(/^rm -f -- /u),
    ]);
  });

  it("returns absence without invoking the archive API for a missing file", async () => {
    const missingExec = successfulExec();
    missingExec.inspect.mockResolvedValue({ ExitCode: 44, Running: false });
    const container = {
      exec: vi.fn(async () => missingExec),
      getArchive: vi.fn(),
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
    };
    const docker = {
      getContainer: vi.fn(() => container),
      modem: {
        demuxStream: vi.fn((_stream, stdout, stderr) => {
          stdout.end();
          stderr.end();
        }),
      },
    } as unknown as Docker;

    await expect(createEngine(docker).readFile(
      SANDBOX_SESSION_ID,
      "/tmp/home/.agents/skills/missing/SKILL.md",
    )).resolves.toBeNull();
    expect(container.getArchive).not.toHaveBeenCalled();
  });

  it("stages a hidden-home write outside tmpfs before moving it in-container", async () => {
    const source = new PassThrough();
    const exec = successfulExec(source);
    const container = {
      exec: vi.fn(async () => exec),
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      putArchive: vi.fn(async () => undefined),
    };
    const docker = {
      getContainer: vi.fn(() => container),
      modem: {
        demuxStream: vi.fn((_stream, stdout, stderr) => {
          stdout.end();
          stderr.end();
        }),
      },
    } as unknown as Docker;

    await createEngine(docker).writeFile(
      SANDBOX_SESSION_ID,
      "/tmp/home/.agents/skills/behavior-preferences/LICENSE.txt",
      new TextEncoder().encode("MIT"),
    );

    expect(container.putArchive).toHaveBeenCalledWith(
      expect.anything(),
      { path: "/.osinara-sandbox-uploads" },
    );
    const commands = container.exec.mock.calls.map(([options]) => options.Cmd.at(-1));
    expect(commands).toEqual([
      expect.stringMatching(/^mkdir -p -- .*\.osinara-sandbox-uploads/u),
      expect.stringMatching(/^mv -T -- .* ".*\/tmp\/home\/\.agents\/skills\/behavior-preferences\/LICENSE\.txt"$/u),
    ]);
  });

  it("rejects a directory destination and observes failed staging cleanup", async () => {
    const exitCodes = [0, 1, 1];
    const container = {
      exec: vi.fn(async () => {
        const source = new PassThrough();
        const exitCode = exitCodes.shift();
        return {
          inspect: vi.fn(async () => ({ ExitCode: exitCode, Running: false })),
          start: vi.fn(async () => source),
        };
      }),
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      putArchive: vi.fn(async () => undefined),
    };
    const docker = {
      getContainer: vi.fn(() => container),
      modem: {
        demuxStream: vi.fn((_stream, stdout, stderr) => {
          stdout.end();
          stderr.end();
        }),
      },
    } as unknown as Docker;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(createEngine(docker).writeFile(
      SANDBOX_SESSION_ID,
      "/tmp/home/.agents/skills/behavior-preferences",
      new TextEncoder().encode("must-not-land-inside-directory"),
    )).rejects.toThrowError(
      /AGENT_SANDBOX_RUNNER_FILE_COMMIT_FAILED: Не удалось записать файл/u,
    );
    const commands = container.exec.mock.calls.map(([options]) => options.Cmd.at(-1));
    expect(commands[1]).toMatch(/^mv -T -- /u);
    expect(commands[2]).toMatch(/^rm -f -- /u);
    expect(consoleError).toHaveBeenCalledWith(
      "Sandbox staged file cleanup failed",
      expect.objectContaining({ exitCode: 1 }),
    );
    consoleError.mockRestore();
  });
});
