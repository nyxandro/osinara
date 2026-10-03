/**
 * Session sandbox to runner integration tests.
 *
 * Constructs covered:
 * - Lazy session creation only when the first sandbox operation actually runs.
 * - One atomic skill batch instead of per-file runner mutations.
 * - Stored metadata restores the same container identity and mounts; other mounts are refused.
 * - Automatic trusted/restricted classification from workspace scopes.
 * - Disabled internal sessions persist no mounts and cannot start sandbox compute.
 * - Shell and file delegation; stop reaches reattachable compute.
 */
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxEngine } from "../../../services/sandbox-runner/sandbox-engine.js";
import { createSandboxRunnerServer } from "../../../services/sandbox-runner/server.js";
import { openRunnerSandbox } from "./runner-sandbox-backend.js";
import { authorizeCurrentExternalGroupCapability } from "../tool-policy/external-group-live-policy.js";
import { externalGroupBash } from "../tool-policy/external-group-bash.js";

const policy = vi.hoisted(() => ({ tools: [] as string[], skills: [] as string[] }));
vi.mock("../database.js", () => ({
  database: () => ({ connect: async () => ({
    query: async () => ({ rows: [{ tool_allowlist: policy.tools, skill_allowlist: policy.skills }] }),
    release: () => undefined,
  }) }),
}));

const SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";
const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const servers: Array<ReturnType<typeof createSandboxRunnerServer>> = [];

function fakeEngine(): SandboxEngine {
  return {
    syncSkills: vi.fn<SandboxEngine["syncSkills"]>(async (_id, request) => ({ checked: request.packages.reduce((count, pkg) => count + pkg.files.length, 0), written: 0, removed: 0 })),
    createSession: vi.fn(async (request) => ({
      created: request.seedFiles !== undefined,
      seedRequired: request.seedFiles === undefined,
      sessionId: request.sandboxSessionId,
      instanceId: "f".repeat(64),
    })),
    deleteToolEnvironment: vi.fn(async () => undefined),
    health: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new TextEncoder().encode("content")),
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
      stdout: "ok\n",
    })),
    stopAllSessions: vi.fn(async () => undefined),
    reconcileIdleSessions: vi.fn(async () => ({ removed: 0, stopped: 0 })),
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
  policy.tools = [];
  policy.skills = [];
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  ));
});

const PERSONAL = [{ mountPoint: "personal" as const, workspaceId: WORKSPACE_ID }];
const GROUP = [{ mountPoint: "group" as const, workspaceId: WORKSPACE_ID }];

async function open(engine: SandboxEngine, mounts: Array<{ mountPoint: "family" | "group" | "personal"; workspaceId: string }>, stored: Record<string, unknown> | null = null) {
  return openRunnerSandbox({ baseUrl: await runnerUrl(engine), sessionId: SESSION_ID, stored, use: { mounts, sandboxSessionId: SANDBOX_SESSION_ID } });
}

describe("session sandbox on the runner", () => {
  it("rechecks the live group skill list before materializing a previously granted package", async () => {
    const engine = fakeEngine();
    const { session } = await open(engine, GROUP);
    const packages = [{ name: "pohuy", files: [{ relativePath: "SKILL.md", content: Buffer.from("ok") }] }];
    policy.tools = ["bash"]; policy.skills = ["pohuy"];
    await session.syncSkills(packages, []);
    expect(engine.syncSkills).toHaveBeenCalledOnce();
    vi.mocked(engine.createSession).mockClear(); vi.mocked(engine.syncSkills).mockClear(); policy.skills = [];
    await expect(session.syncSkills(packages, [])).rejects.toThrow("AGENT_GROUP_SKILL_FORBIDDEN");
    expect(engine.createSession).not.toHaveBeenCalled(); expect(engine.syncSkills).not.toHaveBeenCalled();
  });

  it("forwards a complete skill batch with the exact selected container identity", async () => {
    const engine = fakeEngine();
    const { session } = await open(engine, PERSONAL);
    await session.syncSkills([{ name: "test", files: [{ relativePath: "SKILL.md", content: Buffer.from("ok") }] }], ["removed"]);
    expect(engine.syncSkills).toHaveBeenCalledWith(SANDBOX_SESSION_ID, {
      expectedInstanceId: "f".repeat(64), packages: [{ name: "test", files: [{ path: "SKILL.md", contentBase64: "b2s=" }] }], removed: ["removed"],
    }, expect.any(AbortSignal));
  });

  it.each([false, true])("passes the Bash requirement through the group bash tool (revoked=%s)", async (revoked) => {
    const engine = fakeEngine();
    const { session } = await open(engine, GROUP);
    policy.tools = ["bash"];
    const operation = externalGroupBash.execute({ command: "touch /workspace/group/marker" }, {
      session: { auth: { current: {
        authenticator: "telegram", principalType: "user", principalId: "telegram:101",
        attributes: { familyId: "family", groupId: "group", groupType: "external", role: "external", telegramChatType: "supergroup" },
      } } },
      async getSandbox() {
        // The first authorization already passed, but the sandbox has not been selected yet.
        if (revoked) policy.tools = [];
        return session;
      },
    } as never);
    if (revoked) {
      await expect(operation).rejects.toThrow("AGENT_GROUP_TOOL_FORBIDDEN");
      expect(engine.runProcess).not.toHaveBeenCalled();
    } else {
      await expect(operation).resolves.toMatchObject({ stdout: "ok\n", truncated: false });
      expect(engine.createSession).toHaveBeenCalledWith(expect.objectContaining({ access: "group-tools" }));
      expect(engine.runProcess).toHaveBeenCalledWith(SANDBOX_SESSION_ID,
        expect.objectContaining({ expectedInstanceId: "f".repeat(64) }), expect.any(AbortSignal));
    }
  });

  it.each(["run", "spawn"] as const)("rejects %s after Bash is revoked between the outer check and container selection", async (method) => {
    const engine = fakeEngine();
    const { session } = await open(engine, GROUP);
    policy.tools = ["bash"];
    await authorizeCurrentExternalGroupCapability({ familyId: "family", groupId: "group" }, "bash");
    policy.tools = [];
    const command = { command: "touch /workspace/group/forbidden", requiredGroupCapability: "bash" as const };
    await expect(session[method](command)).rejects.toThrow("AGENT_GROUP_TOOL_FORBIDDEN");
    expect(engine.createSession).not.toHaveBeenCalled();
    expect(engine.runProcess).not.toHaveBeenCalled();
    // Native file tools may still use internal shell commands without a user Bash grant.
    await expect(session.readTextFile({ path: "/workspace/group/kept" })).resolves.toBe("content");
  });

  it("keeps a session without mounts away from sandbox compute, also after a restore", async () => {
    const engine = fakeEngine();
    const initial = await open(engine, []);
    const captured = initial.captureState();

    expect(captured).toEqual({ disabled: true, mounts: [], sandboxSessionId: SANDBOX_SESSION_ID, version: 3 });
    expect(initial.session.id).toBe(SANDBOX_SESSION_ID);
    await expect(initial.session.run({ command: "true" })).rejects.toThrowError(/AGENT_SANDBOX_RUNNER_SESSION_DISABLED/);
    await initial.session.stop();
    expect(engine.stopSession).not.toHaveBeenCalled();

    const restored = await open(engine, [], captured as unknown as Record<string, unknown>);
    await expect(restored.session.readTextFile({ path: "note.txt" })).rejects.toThrowError(/AGENT_SANDBOX_RUNNER_SESSION_DISABLED/);
    expect(engine.createSession).not.toHaveBeenCalled();
  });

  it("starts a trusted persistent workspace only on the first operation, with no seed files", async () => {
    const engine = fakeEngine();
    const { session } = await open(engine, PERSONAL);

    expect(engine.createSession).not.toHaveBeenCalled();
    await expect(session.run({ command: "printf ok" })).resolves.toMatchObject({ exitCode: 0, stdout: "ok\n" });
    await session.writeTextFile({ path: "note.txt", content: "hello" });
    await expect(session.readTextFile({ path: "note.txt" })).resolves.toBe("content");

    expect(engine.createSession).toHaveBeenCalledWith({
      access: "trusted",
      eveSessionId: SESSION_ID,
      mounts: PERSONAL,
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      seedFiles: [],
    });
    expect(session.id).toBe(SANDBOX_SESSION_ID);
    await session.stop();
    expect(engine.stopSession).toHaveBeenCalledWith(SANDBOX_SESSION_ID);
  });

  it("classifies a group-only session as restricted and rejects network escalation", async () => {
    const engine = fakeEngine();
    const { session } = await open(engine, GROUP);

    await session.run({ command: "true" });
    expect(engine.createSession).toHaveBeenCalledWith(expect.objectContaining({ access: "restricted" }));
    await expect(session.setNetworkPolicy("allow-all")).rejects.toThrowError(/AGENT_SANDBOX_RUNNER_NETWORK_POLICY_FORBIDDEN/);
  });

  it("restores the stored container identity and refuses a different set of folders", async () => {
    const engine = fakeEngine();
    const initial = await open(engine, PERSONAL);
    const stored = initial.captureState() as unknown as Record<string, unknown>;
    const restored = await open(engine, PERSONAL, stored);

    await expect(restored.session.run({ command: "printf restored" })).resolves.toMatchObject({ exitCode: 0 });
    expect(engine.createSession).toHaveBeenCalledWith(expect.objectContaining({ access: "trusted", mounts: PERSONAL, sandboxSessionId: SANDBOX_SESSION_ID }));
    await expect(restored.session.setNetworkPolicy("allow-all")).resolves.toBeUndefined();
    await expect(open(engine, [{ mountPoint: "family", workspaceId: WORKSPACE_ID }], stored)).rejects.toThrow("AGENT_SANDBOX_RUNNER_REMOUNT_DENIED");
    await expect(open(engine, [], stored)).rejects.toThrow("AGENT_SANDBOX_RUNNER_REMOUNT_DENIED");
  });
});
