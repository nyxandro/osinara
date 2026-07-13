/**
 * Internal sandbox runner HTTP boundary tests.
 *
 * Constructs covered:
 * - Health and validated session creation routes.
 * - Fail-closed rejection before the Docker engine boundary.
 * - Process execution and disposable session removal delegation.
 */
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxEngine } from "./sandbox-engine.js";
import { createSandboxRunnerServer } from "./server.js";

const SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";
const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const servers: Array<ReturnType<typeof createSandboxRunnerServer>> = [];

function fakeEngine(): SandboxEngine {
  return {
    createSession: vi.fn(async () => ({ created: true, sessionId: SANDBOX_SESSION_ID })),
    deleteToolEnvironment: vi.fn(async () => undefined),
    health: vi.fn(async () => undefined),
    readFile: vi.fn(async () => null),
    removePath: vi.fn(async () => undefined),
    runProcess: vi.fn(async () => ({
      exitCode: 0,
      processId: "process-1",
      stderr: "",
      stdout: "Linux\n",
    })),
    stopAllSessions: vi.fn(async () => undefined),
    removeIdleSessions: vi.fn(async () => 0),
    stopSession: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  };
}

async function start(engine: SandboxEngine): Promise<string> {
  const server = createSandboxRunnerServer({ engine });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  ));
});

describe("sandbox runner HTTP server", () => {
  it("creates a validated trusted session and delegates commands", async () => {
    const engine = fakeEngine();
    const baseUrl = await start(engine);
    const sessionResponse = await fetch(`${baseUrl}/v1/sessions`, {
      body: JSON.stringify({
        access: "trusted",
        mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
        eveSessionId: SESSION_ID,
        sandboxSessionId: SANDBOX_SESSION_ID,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const processResponse = await fetch(
      `${baseUrl}/v1/sessions/${encodeURIComponent(SANDBOX_SESSION_ID)}/processes`, {
      body: JSON.stringify({ command: "uname -s" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      },
    );

    expect(sessionResponse.status).toBe(201);
    expect(await processResponse.json()).toMatchObject({ exitCode: 0, stdout: "Linux\n" });
    expect(engine.createSession).toHaveBeenCalledWith({
      access: "trusted",
      eveSessionId: SESSION_ID,
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
    });
    expect(engine.runProcess).toHaveBeenCalledWith(
      SANDBOX_SESSION_ID,
      { command: "uname -s" },
      expect.any(AbortSignal),
    );
  });

  it("rejects a group mount before invoking the trusted engine path", async () => {
    const engine = fakeEngine();
    const baseUrl = await start(engine);
    const response = await fetch(`${baseUrl}/v1/sessions`, {
      body: JSON.stringify({
        access: "trusted",
        eveSessionId: SESSION_ID,
        mounts: [{ mountPoint: "group", workspaceId: WORKSPACE_ID }],
        sandboxSessionId: SANDBOX_SESSION_ID,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "AGENT_SANDBOX_RUNNER_REQUEST_INVALID" });
    expect(engine.createSession).not.toHaveBeenCalled();
  });

  it("checks Docker health and delegates disposable compute and tool deletion", async () => {
    const engine = fakeEngine();
    const baseUrl = await start(engine);

    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/sessions/${SANDBOX_SESSION_ID}/stop`, {
      method: "POST",
    })).status).toBe(204);
    expect((await fetch(`${baseUrl}/v1/tool-environments/${WORKSPACE_ID}`, { method: "DELETE" })).status)
      .toBe(204);
    expect(engine.health).toHaveBeenCalledOnce();
    expect(engine.stopSession).toHaveBeenCalledWith(SANDBOX_SESSION_ID);
    expect(engine.deleteToolEnvironment).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});
