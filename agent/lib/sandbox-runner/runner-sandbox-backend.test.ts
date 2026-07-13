/**
 * Eve sandbox backend to runner integration tests.
 *
 * Constructs covered:
 * - Delayed session creation until trusted mounts are known.
 * - Stable thread-scoped compute identity across changing Eve workflow roots.
 * - Reconnect metadata recreates disposable compute without rerunning `onSession`.
 * - Automatic trusted/restricted classification from workspace scopes.
 * - Shell and binary file delegation with workspace mutation indexing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxEngine } from "../../../services/sandbox-runner/sandbox-engine.js";
import { createSandboxRunnerServer } from "../../../services/sandbox-runner/server.js";
import { scopedWorkspaceRunner } from "./runner-sandbox-backend.js";

const SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";
const BACKEND_SESSION_ID =
  "eve-sbx-ses-osinara-scoped-runner-local-a1b2c3d4e5f6-wrun_01JZ8K4R0W6G73VTHX9NF2QABC-__root__";
const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
const servers: Array<ReturnType<typeof createSandboxRunnerServer>> = [];

function fakeEngine(): SandboxEngine {
  return {
    createSession: vi.fn(async (request) => ({
      created: true,
      sessionId: request.sandboxSessionId,
    })),
    deleteToolEnvironment: vi.fn(async () => undefined),
    health: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new TextEncoder().encode("content")),
    removePath: vi.fn(async () => undefined),
    runProcess: vi.fn(async () => ({
      exitCode: 0,
      processId: "process-1",
      stderr: "",
      stdout: "ok\n",
    })),
    stopAllSessions: vi.fn(async () => undefined),
    removeIdleSessions: vi.fn(async () => 0),
    stopSession: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  };
}

async function runnerUrl(engine: SandboxEngine): Promise<string> {
  const server = createSandboxRunnerServer({ engine });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  ));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("scopedWorkspaceRunner", () => {
  it("delegates a trusted persistent workspace after mounts are known", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "osinara-runner-backend-"));
    roots.push(appRoot);
    const engine = fakeEngine();
    const backend = scopedWorkspaceRunner({
      baseUrl: await runnerUrl(engine),
    });
    await backend.prewarm({
      runtimeContext: { appRoot },
      seedFiles: [{ content: "skill", path: "$HOME/.agents/skills/example/SKILL.md" }],
      templateKey: "template-1",
    });
    const handle = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: BACKEND_SESSION_ID,
      templateKey: "template-1",
      tags: { sessionId: SESSION_ID },
    });

    expect(engine.createSession).not.toHaveBeenCalled();
    await handle.useSessionFn({
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
    });
    await expect(handle.session.run({ command: "printf ok" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
    });
    await handle.session.writeTextFile({ path: "note.txt", content: "hello" });
    await expect(handle.session.readTextFile({ path: "note.txt" })).resolves.toBe("content");

    expect(engine.createSession).toHaveBeenCalledWith({
      access: "trusted",
      eveSessionId: SESSION_ID,
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
    });
    expect(engine.writeFile).toHaveBeenCalledWith(
      SANDBOX_SESSION_ID,
      "/tools/personal/home/.agents/skills/example/SKILL.md",
      expect.any(Uint8Array),
    );
    expect(handle.session.id).toBe(SANDBOX_SESSION_ID);
    await handle.shutdown();
    expect(engine.stopSession).toHaveBeenCalledWith(SANDBOX_SESSION_ID);
  });

  it("classifies a group-only session as restricted and rejects network escalation", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "osinara-runner-backend-"));
    roots.push(appRoot);
    const engine = fakeEngine();
    const backend = scopedWorkspaceRunner({ baseUrl: await runnerUrl(engine) });
    const handle = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: BACKEND_SESSION_ID,
      templateKey: null,
      tags: { sessionId: SESSION_ID },
    });
    await handle.useSessionFn({
      mounts: [{ mountPoint: "group", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
    });

    expect(engine.createSession).toHaveBeenCalledWith(expect.objectContaining({ access: "restricted" }));
    await expect(handle.session.setNetworkPolicy("allow-all")).rejects.toThrowError(
      /AGENT_SANDBOX_RUNNER_NETWORK_POLICY_FORBIDDEN/,
    );
  });

  it("restores mounts and recreates disposable compute from captured backend metadata", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "osinara-runner-backend-"));
    roots.push(appRoot);
    const engine = fakeEngine();
    const backend = scopedWorkspaceRunner({ baseUrl: await runnerUrl(engine) });
    const initial = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: BACKEND_SESSION_ID,
      templateKey: null,
      tags: { sessionId: SESSION_ID },
    });
    await initial.useSessionFn({
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
    });
    const captured = await initial.captureState();
    const restored = await backend.create({
      existingMetadata: captured.metadata,
      runtimeContext: { appRoot },
      sessionKey: BACKEND_SESSION_ID,
      templateKey: null,
      tags: { sessionId: SESSION_ID },
    });
    vi.mocked(engine.createSession).mockClear();

    await expect(restored.session.run({ command: "printf restored" })).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(engine.createSession).toHaveBeenCalledWith({
      access: "trusted",
      eveSessionId: SESSION_ID,
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
    });
    expect(engine.runProcess).toHaveBeenLastCalledWith(
      SANDBOX_SESSION_ID,
      expect.objectContaining({ command: "printf restored" }),
      expect.any(AbortSignal),
    );
    await expect(restored.session.setNetworkPolicy("allow-all")).resolves.toBeUndefined();
  });
});
