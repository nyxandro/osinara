/**
 * Docker sandbox isolation option tests.
 *
 * Constructs covered:
 * - Scoped workspace mounts and exactly one active persistent tool environment.
 * - Native Bash never receives the Google credential profile or gws execution boundary.
 * - Public-only proxy egress for trusted sessions.
 * - Network-less, tool-less external-group containers.
 * - Resource, capability, and privilege restrictions.
 * - Stale policy replacement and bounded warm-cache reconciliation at the Docker boundary.
 * - Explicit session and runner shutdown remove compute instead of retaining exited containers.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSandboxContainerOptions,
  createDockerSandboxEngine,
} from "./docker-sandbox-engine.js";
import { buildGoogleWorkspaceContainerOptions } from "./docker-sandbox-options.js";
import { sandboxRequestHash } from "./docker-sandbox-lifecycle.js";

const PERSONAL_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const FAMILY_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";
const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMPTY_SEED_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const temporaryRoots: string[] = [];

const runtime = {
  egressNetwork: "osinara_sandbox-egress",
  image: "osinara-sandbox-runtime:local",
  project: "osinara",
  toolsVolume: "osinara_tool-environments",
  workspaceVolume: "osinara_workspace-data",
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("buildSandboxContainerOptions", () => {
  it("keeps family files visible in private chat without exposing Google credentials", () => {
    const options = buildSandboxContainerOptions(runtime, {
      access: "trusted",
      agentSessionId: AGENT_SESSION_ID,
      mounts: [
        { mountPoint: "personal", workspaceId: PERSONAL_WORKSPACE_ID },
        { mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID },
      ],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
    });

    expect(options.HostConfig?.Mounts).toEqual([
      expect.objectContaining({
        Source: runtime.workspaceVolume,
        Target: "/workspace/personal",
        VolumeOptions: { Subpath: PERSONAL_WORKSPACE_ID },
      }),
      expect.objectContaining({
        Source: runtime.workspaceVolume,
        Target: "/workspace/family",
        VolumeOptions: { Subpath: FAMILY_WORKSPACE_ID },
      }),
      expect.objectContaining({
        Source: runtime.toolsVolume,
        Target: "/tools/personal",
        VolumeOptions: { Subpath: PERSONAL_WORKSPACE_ID },
      }),
    ]);
    expect(options.HostConfig).toMatchObject({
      CapDrop: ["ALL"],
      Init: true,
      NetworkMode: runtime.egressNetwork,
      PidsLimit: 256,
      Privileged: false,
      ReadonlyRootfs: false,
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: expect.objectContaining({
        "/opt/osinara": expect.stringContaining("noexec"),
      }),
    });
    expect(options.Labels).toMatchObject({
      "dev.osinara.sandbox.policy-version": "10",
      "dev.osinara.sandbox.project": "osinara",
      "dev.osinara.sandbox.session-id": SANDBOX_SESSION_ID,
    });
    expect(options.Env).toEqual(expect.arrayContaining([
      "AGENT_BROWSER_RESTORE=osinara",
      "AGENT_BROWSER_RESTORE_SAVE=auto",
      "AGENT_BROWSER_SESSION=osinara",
      "HOME=/tools/personal/home",
      "HTTPS_PROXY=http://sandbox-egress-proxy:3128",
      "NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian-trusted-root-ca.crt",
      "NODE_USE_ENV_PROXY=1",
      "NPM_CONFIG_PREFIX=/tools/personal/npm",
    ]));
    expect(options.Env).not.toEqual(expect.arrayContaining([
      expect.stringContaining("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"),
      expect.stringContaining("/tools/family"),
    ]));
  });

  it("creates one-shot GWS compute with exact argv and only one workspace", () => {
    const dangerous = "$(touch /tmp/pwned); a && rm -rf /";
    const options = buildGoogleWorkspaceContainerOptions(runtime, {
      accessToken: "access-secret",
      argv: ["gmail", "+send", "--subject", dangerous],
      timeoutMs: 60_000,
      workspaceId: PERSONAL_WORKSPACE_ID,
    });

    expect(options.Cmd).toEqual(["/opt/osinara/gws", "gmail", "+send", "--subject", dangerous]);
    expect(options.HostConfig?.Mounts).toEqual([
      expect.objectContaining({
        Target: "/workspace",
        VolumeOptions: { Subpath: PERSONAL_WORKSPACE_ID },
      }),
    ]);
    expect(options.Env).toContain("GOOGLE_WORKSPACE_CLI_TOKEN=access-secret");
    expect(options.HostConfig).toMatchObject({ ReadonlyRootfs: true });
  });

  it("mounts only the family tool environment without Google credentials", () => {
    const options = buildSandboxContainerOptions(runtime, {
      access: "trusted",
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
    });

    expect(options.HostConfig?.Mounts).toEqual([
      expect.objectContaining({
        Source: runtime.workspaceVolume,
        Target: "/workspace/family",
        VolumeOptions: { Subpath: FAMILY_WORKSPACE_ID },
      }),
      expect.objectContaining({
        Source: runtime.toolsVolume,
        Target: "/tools/family",
        VolumeOptions: { Subpath: FAMILY_WORKSPACE_ID },
      }),
    ]);
    expect(options.Env).toEqual(expect.arrayContaining([
      "HOME=/tools/family/home",
      "NPM_CONFIG_PREFIX=/tools/family/npm",
    ]));
    expect(options.Env).not.toEqual(expect.arrayContaining([
      expect.stringContaining("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"),
    ]));
  });

  it("gives an external group no tools volume and no network", () => {
    const options = buildSandboxContainerOptions(runtime, {
      access: "restricted",
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
    });

    expect(options.HostConfig?.NetworkMode).toBe("none");
    expect(options.HostConfig?.Mounts).toEqual([
      expect.objectContaining({
        Source: runtime.workspaceVolume,
        Target: "/workspace/group",
        VolumeOptions: { Subpath: GROUP_WORKSPACE_ID },
      }),
    ]);
    // Each fragment is an independent trust-boundary violation; a combined subset check is weaker.
    for (const forbiddenEnvironmentFragment of [
      "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE",
      "NODE_EXTRA_CA_CERTS=",
      "NODE_USE_ENV_PROXY=",
      "PROXY=",
      "/tools/",
    ]) {
      expect(options.Env).not.toEqual(expect.arrayContaining([
        expect.stringContaining(forbiddenEnvironmentFragment),
      ]));
    }
  });

  it("gives an enabled group its own tools and dedicated proxy-only network, not the trusted network", () => {
    const request = {
      access: "group-tools" as const,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "group" as const, workspaceId: GROUP_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
    };
    const groupNetwork = `osinara-group-egress-${GROUP_WORKSPACE_ID}`;
    const options = buildSandboxContainerOptions(runtime, request, groupNetwork);
    expect(options.HostConfig?.NetworkMode).toBe(groupNetwork);
    expect(options.HostConfig?.NetworkMode).not.toBe(runtime.egressNetwork);
    expect(options.HostConfig?.Mounts).toEqual([
      expect.objectContaining({ Target: "/workspace/group", VolumeOptions: { Subpath: GROUP_WORKSPACE_ID } }),
      expect.objectContaining({ Target: "/tools/group", VolumeOptions: { Subpath: GROUP_WORKSPACE_ID } }),
    ]);
    expect(options.Env).toContain("HOME=/tools/group/home");
    expect(options.Env).toContain("AGENT_BROWSER_PROXY=http://sandbox-egress-proxy:3128");
    expect(options.Env?.join("\n")).not.toMatch(/\/tools\/(personal|family)|GOOGLE_WORKSPACE_CLI_TOKEN/u);
    expect(() => buildSandboxContainerOptions(runtime, request)).toThrow("AGENT_SANDBOX_GROUP_NETWORK_REQUIRED");
  });

  it("replaces stale policy compute while preserving named-volume data", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-sandbox-engine-"));
    temporaryRoots.push(root);
    const stale = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: {
            "dev.osinara.sandbox.request-hash": "stale-policy",
            "dev.osinara.sandbox.session-id": SANDBOX_SESSION_ID,
          },
        },
        State: { Running: true },
      })),
      remove: vi.fn(async () => undefined),
    };
    const replacement = {
      putArchive: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    };
    const docker = {
      createContainer: vi.fn(async () => replacement),
      getContainer: vi.fn(() => stale),
    } as unknown as Docker;
    const engine = createDockerSandboxEngine({
      docker,
      roots: {
        toolsRoot: `${root}/tools`,
        workspaceRoot: `${root}/workspaces`,
      },
      runtime,
    });

    await expect(engine.createSession({
      access: "restricted",
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: "a".repeat(64),
      seedFiles: [{ contentBase64: Buffer.from("skill").toString("base64"), path: "/workspace/skill.md" }],
    })).resolves.toEqual({ created: true, seedRequired: false, sessionId: SANDBOX_SESSION_ID });
    expect(stale.remove).toHaveBeenCalledWith({ force: true, v: true });
    expect(docker.createContainer).toHaveBeenCalledOnce();
    expect(replacement.start).toHaveBeenCalledOnce();
    expect(replacement.putArchive).toHaveBeenCalledOnce();
  });

  it("restarts a matching warm container without requesting or writing seeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-sandbox-engine-"));
    temporaryRoots.push(root);
    const request = {
      access: "restricted" as const,
      agentSessionId: AGENT_SESSION_ID,
      mounts: [{ mountPoint: "group" as const, workspaceId: GROUP_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: EMPTY_SEED_DIGEST,
    };
    const start = vi.fn(async () => undefined);
    const existing = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: {
            "dev.osinara.sandbox.request-hash": sandboxRequestHash(request),
            "dev.osinara.sandbox.session-id": SANDBOX_SESSION_ID,
          },
        },
        State: { Running: false },
      })),
      start,
    };
    const docker = {
      createContainer: vi.fn(),
      getContainer: vi.fn(() => existing),
    } as unknown as Docker;
    const engine = createDockerSandboxEngine({
      docker,
      roots: {
        toolsRoot: `${root}/tools`,
        workspaceRoot: `${root}/workspaces`,
      },
      runtime,
    });

    await expect(engine.createSession(request)).resolves.toEqual({
      created: false,
      seedRequired: false,
      sessionId: SANDBOX_SESSION_ID,
    });
    expect(start).toHaveBeenCalledOnce();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("stops idle compute, retains a recent warm container, and removes an expired one", async () => {
    const now = new Date("2026-07-30T20:00:00.000Z");
    const stopRunning = vi.fn(async () => undefined);
    const removeRecent = vi.fn(async () => undefined);
    const removeExpired = vi.fn(async () => undefined);
    const containers = {
      "running-idle": { stop: stopRunning },
      "stopped-recent": {
        inspect: vi.fn(async () => ({ State: { FinishedAt: "2026-07-30T19:00:00.000Z", Running: false } })),
        remove: removeRecent,
      },
      "stopped-expired": {
        inspect: vi.fn(async () => ({ State: { FinishedAt: "2026-07-29T18:00:00.000Z", Running: false } })),
        remove: removeExpired,
      },
    } as const;
    const docker = {
      getContainer: vi.fn((id: keyof typeof containers) => containers[id]),
      listNetworks: vi.fn(async () => []),
      listContainers: vi.fn(async () => [
        {
          Id: "running-idle",
          Labels: { "dev.osinara.sandbox.session-id": SANDBOX_SESSION_ID },
          State: "running",
        },
        {
          Id: "stopped-recent",
          Labels: {
            "dev.osinara.sandbox.session-id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          },
          State: "exited",
        },
        {
          Id: "stopped-expired",
          Labels: {
            "dev.osinara.sandbox.session-id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          },
          State: "exited",
        },
      ]),
    } as unknown as Docker;
    const engine = createDockerSandboxEngine({
      docker,
      roots: {
        toolsRoot: "/tools",
        workspaceRoot: "/workspaces",
      },
      runtime,
    });

    await expect(engine.reconcileIdleSessions(now)).resolves.toEqual({ removed: 1, stopped: 1 });
    expect(stopRunning).toHaveBeenCalledOnce();
    expect(removeRecent).not.toHaveBeenCalled();
    expect(removeExpired).toHaveBeenCalledWith({ force: true, v: true });
  });

  it("restarts idle compute before a filesystem mutation", async () => {
    const start = vi.fn(async () => undefined);
    const exec = {
      inspect: vi.fn(async () => ({ ExitCode: 0 })),
      start: vi.fn(async () => Readable.from([])),
    };
    const container = {
      exec: vi.fn(async () => exec),
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: false } })),
      start,
    };
    const docker = {
      getContainer: vi.fn(() => container),
    } as unknown as Docker;
    const engine = createDockerSandboxEngine({
      docker,
      roots: {
        toolsRoot: "/tools",
        workspaceRoot: "/workspaces",
      },
      runtime,
    });

    await expect(engine.removePath(SANDBOX_SESSION_ID, {
      force: true,
      path: "obsolete.txt",
    })).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledOnce();
  });

  it("removes compute on session and runner shutdown", async () => {
    const removeSession = vi.fn(async () => undefined);
    const removeOrphan = vi.fn(async () => undefined);
    const removeGoogleWorkspaceOrphan = vi.fn(async () => undefined);
    const sessionContainer = {
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      remove: removeSession,
    };
    const docker = {
      getContainer: vi.fn((id: string) =>
        id === "shutdown-orphan"
          ? { remove: removeOrphan }
          : id === "gws-orphan"
          ? { remove: removeGoogleWorkspaceOrphan }
          : sessionContainer
      ),
      listNetworks: vi.fn(async () => []),
      listContainers: vi.fn(async () => [
        {
          Id: "shutdown-orphan",
          Labels: { "dev.osinara.sandbox.session-id": SANDBOX_SESSION_ID },
          State: "exited",
        },
        {
          Id: "gws-orphan",
          Labels: { "dev.osinara.google-workspace-execution": "true" },
          State: "exited",
        },
      ]),
    } as unknown as Docker;
    const engine = createDockerSandboxEngine({
      docker,
      roots: {
        toolsRoot: "/tools",
        workspaceRoot: "/workspaces",
      },
      runtime,
    });

    await engine.stopSession(SANDBOX_SESSION_ID);
    await engine.stopAllSessions();

    expect(removeSession).toHaveBeenCalledWith({ force: true, v: true });
    expect(removeOrphan).toHaveBeenCalledWith({ force: true, v: true });
    expect(removeGoogleWorkspaceOrphan).toHaveBeenCalledWith({ force: true, v: true });
  });

  it("keeps repeated shutdown idempotent when another handle removed the container", async () => {
    const missing = Object.assign(new Error("container already removed"), { statusCode: 404 });
    const container = {
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      remove: vi.fn(async () => Promise.reject(missing)),
    };
    const docker = { getContainer: vi.fn(() => container) } as unknown as Docker;
    const engine = createDockerSandboxEngine({
      docker,
      roots: {
        toolsRoot: "/tools",
        workspaceRoot: "/workspaces",
      },
      runtime,
    });

    await expect(engine.stopSession(SANDBOX_SESSION_ID)).resolves.toBeUndefined();
  });
});
