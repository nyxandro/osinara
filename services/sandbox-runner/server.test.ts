/**
 * Internal sandbox runner HTTP boundary tests.
 *
 * Constructs covered:
 * - Health and validated session creation routes.
 * - Fail-closed rejection before the Docker engine boundary.
 * - Process, isolated GWS execution, and disposable session removal delegation.
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
    syncSkills: vi.fn(async () => ({ checked: 1, written: 0, removed: 0 })),
    createSession: vi.fn(async () => ({
      created: true,
      seedRequired: false,
      sessionId: SANDBOX_SESSION_ID,
    })),
    deleteToolEnvironment: vi.fn(async () => undefined),
    health: vi.fn(async () => undefined),
    readFile: vi.fn(async () => null),
    removePath: vi.fn(async () => undefined),
    runGoogleWorkspace: vi.fn(async () => ({
      exitCode: 0,
      processId: "gws-process-1",
      stderr: "",
      stdout: "{}",
    })),
    runProcess: vi.fn(async () => ({
      exitCode: 0,
      processId: "process-1",
      stderr: "",
      stdout: "Linux\n",
    })),
    stopAllSessions: vi.fn(async () => undefined),
    reconcileIdleSessions: vi.fn(async () => ({ removed: 0, stopped: 0 })),
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
  it("stops admission and waits for accepted creation work before shutdown completes", async () => {
    const engine = fakeEngine(), baseUrl = await start(engine), server = servers.at(-1)!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    engine.createSession = vi.fn(async () => { await gate; return { created: true, seedRequired: false, sessionId: SANDBOX_SESSION_ID }; });
    const incoming = fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      access: "restricted", agentSessionId: SESSION_ID, sandboxSessionId: SANDBOX_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: WORKSPACE_ID }], seedDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", seedFiles: [],
    }) });
    try {
      await vi.waitFor(() => expect(engine.createSession).toHaveBeenCalledOnce());
      let drained = false;
      const closing = server.closeAndDrain().then(() => { drained = true; });
      servers.splice(servers.indexOf(server), 1);
      await expect(incoming).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve, 0)); expect(drained).toBe(false);
      await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
      release(); await closing; expect(drained).toBe(true);
    } finally { release(); await incoming.catch(() => undefined); }
  });
  it("cancels skill synchronization when its HTTP caller disconnects", async () => {
    const engine = fakeEngine(), baseUrl = await start(engine), controller = new AbortController();
    let deliveredSignal: AbortSignal | undefined;
    engine.syncSkills = vi.fn(async (_id, _request, signal) => {
      deliveredSignal = signal;
      await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { checked: 0, written: 0, removed: 0 };
    });
    const request = fetch(`${baseUrl}/v1/sessions/${SANDBOX_SESSION_ID}/skills`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ expectedInstanceId: "a".repeat(64), packages: [], removed: [] }),
    });
    const rejected = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(deliveredSignal).toBeDefined()); controller.abort();
    await rejected; await vi.waitFor(() => expect(deliveredSignal!.aborted).toBe(true));
  });
  it("validates a bulk skill update and refuses traversal before engine execution", async () => {
    const engine = fakeEngine(); const baseUrl = await start(engine);
    const body = { expectedInstanceId: "a".repeat(64), removed: [], packages: [{ name: "test", files: [{ path: "SKILL.md", contentBase64: "b2s=" }] }] };
    const response = await fetch(`${baseUrl}/v1/sessions/${SANDBOX_SESSION_ID}/skills`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(engine.syncSkills).toHaveBeenCalledWith(SANDBOX_SESSION_ID, body, expect.any(AbortSignal));
    body.packages[0]!.files[0]!.path = "../outside";
    const invalid = await fetch(`${baseUrl}/v1/sessions/${SANDBOX_SESSION_ID}/skills`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(invalid.status).toBe(400);
    expect(engine.syncSkills).toHaveBeenCalledOnce();
  });
  it("reports revoked instance identity without losing its stable error code", async () => {
    const engine = fakeEngine();
    vi.mocked(engine.runProcess).mockRejectedValue(new Error("AGENT_SANDBOX_RUNNER_INSTANCE_STALE: changed"));
    const baseUrl = await start(engine);
    const response = await fetch(`${baseUrl}/v1/sessions/${SANDBOX_SESSION_ID}/processes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "touch /workspace/group/marker", expectedInstanceId: "a".repeat(64) }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AGENT_SANDBOX_RUNNER_INSTANCE_STALE" });
  });
  it("validates and delegates exact credentialed GWS argv", async () => {
    const engine = fakeEngine();
    const baseUrl = await start(engine);
    const body = {
      accessToken: "access-secret",
      argv: ["calendar", "events", "list", "--params", "{}"],
      timeoutMs: 60_000,
      workspaceId: WORKSPACE_ID,
    };

    const response = await fetch(`${baseUrl}/v1/google-workspace/executions`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(engine.runGoogleWorkspace).toHaveBeenCalledWith(body, expect.any(AbortSignal));
  });

  it("creates a validated trusted session and delegates commands", async () => {
    const engine = fakeEngine();
    const baseUrl = await start(engine);
    const sessionResponse = await fetch(`${baseUrl}/v1/sessions`, {
      body: JSON.stringify({
        access: "trusted",
        mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
        agentSessionId: SESSION_ID,
        sandboxSessionId: SANDBOX_SESSION_ID,
        seedDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
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
      agentSessionId: SESSION_ID,
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
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
        agentSessionId: SESSION_ID,
        mounts: [{ mountPoint: "group", workspaceId: WORKSPACE_ID }],
        sandboxSessionId: SANDBOX_SESSION_ID,
        seedDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
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
