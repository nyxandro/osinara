/**
 * Docker sandbox isolation option tests.
 *
 * Constructs covered:
 * - Scoped workspace mounts and exactly one active persistent tool environment.
 * - Public-only proxy egress for trusted sessions.
 * - Network-less, tool-less external-group containers.
 * - Resource, capability, and privilege restrictions.
 * - Stale policy replacement and idle disposable-compute removal at the Docker boundary.
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

const PERSONAL_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const FAMILY_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const EVE_SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";
const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const temporaryRoots: string[] = [];

const runtime = {
  googleWorkspaceCredentialsVolume: "osinara_google-workspace-credentials",
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
  it("keeps family files visible in private chat without mounting family credentials", () => {
    const options = buildSandboxContainerOptions(runtime, {
      access: "trusted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [
        { mountPoint: "personal", workspaceId: PERSONAL_WORKSPACE_ID },
        { mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID },
      ],
      sandboxSessionId: SANDBOX_SESSION_ID,
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
      expect.objectContaining({
        ReadOnly: true,
        Source: runtime.googleWorkspaceCredentialsVolume,
        Target: "/credentials/google-workspace",
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
    });
    expect(options.Labels).toMatchObject({
      "dev.osinara.sandbox.policy-version": "5",
      "dev.osinara.sandbox.project": "osinara",
      "dev.osinara.sandbox.session-id": SANDBOX_SESSION_ID,
    });
    expect(options.Env).toEqual(expect.arrayContaining([
      "AGENT_BROWSER_RESTORE=osinara",
      "AGENT_BROWSER_RESTORE_SAVE=auto",
      "AGENT_BROWSER_SESSION=osinara",
      "HOME=/tools/personal/home",
      "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/credentials/google-workspace/credentials.json",
      "HTTPS_PROXY=http://sandbox-egress-proxy:3128",
      "NPM_CONFIG_PREFIX=/tools/personal/npm",
    ]));
    expect(options.Env).not.toEqual(expect.arrayContaining([
      expect.stringContaining("/tools/family"),
    ]));
  });

  it("mounts only the family tool environment in a family chat", () => {
    const options = buildSandboxContainerOptions(runtime, {
      access: "trusted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [{ mountPoint: "family", workspaceId: FAMILY_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
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
      expect.objectContaining({
        ReadOnly: true,
        Source: runtime.googleWorkspaceCredentialsVolume,
        Target: "/credentials/google-workspace",
        VolumeOptions: { Subpath: FAMILY_WORKSPACE_ID },
      }),
    ]);
    expect(options.Env).toEqual(expect.arrayContaining([
      "HOME=/tools/family/home",
      "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/credentials/google-workspace/credentials.json",
      "NPM_CONFIG_PREFIX=/tools/family/npm",
    ]));
  });

  it("gives an external group no tools volume and no network", () => {
    const options = buildSandboxContainerOptions(runtime, {
      access: "restricted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
    });

    expect(options.HostConfig?.NetworkMode).toBe("none");
    expect(options.HostConfig?.Mounts).toEqual([
      expect.objectContaining({
        Source: runtime.workspaceVolume,
        Target: "/workspace/group",
        VolumeOptions: { Subpath: GROUP_WORKSPACE_ID },
      }),
    ]);
    expect(options.Env).not.toEqual(expect.arrayContaining([
      expect.stringContaining("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"),
      expect.stringContaining("PROXY="),
      expect.stringContaining("/tools/"),
    ]));
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
        googleWorkspaceCredentialsRoot: `${root}/google-workspace-credentials`,
        toolsRoot: `${root}/tools`,
        workspaceRoot: `${root}/workspaces`,
      },
      runtime,
    });

    await expect(engine.createSession({
      access: "restricted",
      eveSessionId: EVE_SESSION_ID,
      mounts: [{ mountPoint: "group", workspaceId: GROUP_WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
    })).resolves.toEqual({ created: true, sessionId: SANDBOX_SESSION_ID });
    expect(stale.remove).toHaveBeenCalledWith({ force: true, v: true });
    expect(docker.createContainer).toHaveBeenCalledOnce();
    expect(replacement.start).toHaveBeenCalledOnce();
  });

  it("removes running and stopped orphan compute during idle reconciliation", async () => {
    const removeRunning = vi.fn(async () => undefined);
    const removeStopped = vi.fn(async () => undefined);
    const docker = {
      getContainer: vi.fn((id: string) => ({
        remove: id === "running-orphan" ? removeRunning : removeStopped,
      })),
      listContainers: vi.fn(async () => [
        {
          Id: "running-orphan",
          Labels: { "dev.osinara.sandbox.session-id": SANDBOX_SESSION_ID },
          State: "running",
        },
        {
          Id: "stopped-orphan",
          Labels: {
            "dev.osinara.sandbox.session-id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          },
          State: "exited",
        },
      ]),
    } as unknown as Docker;
    const engine = createDockerSandboxEngine({
      docker,
      roots: {
        googleWorkspaceCredentialsRoot: "/google-workspace-credentials",
        toolsRoot: "/tools",
        workspaceRoot: "/workspaces",
      },
      runtime,
    });

    await expect(engine.removeIdleSessions(new Date())).resolves.toBe(2);
    expect(removeRunning).toHaveBeenCalledWith({ force: true, v: true });
    expect(removeStopped).toHaveBeenCalledWith({ force: true, v: true });
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
        googleWorkspaceCredentialsRoot: "/google-workspace-credentials",
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
    const sessionContainer = {
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      remove: removeSession,
    };
    const docker = {
      getContainer: vi.fn((id: string) =>
        id === "shutdown-orphan" ? { remove: removeOrphan } : sessionContainer
      ),
      listContainers: vi.fn(async () => [{
        Id: "shutdown-orphan",
        Labels: { "dev.osinara.sandbox.session-id": SANDBOX_SESSION_ID },
        State: "exited",
      }]),
    } as unknown as Docker;
    const engine = createDockerSandboxEngine({
      docker,
      roots: {
        googleWorkspaceCredentialsRoot: "/google-workspace-credentials",
        toolsRoot: "/tools",
        workspaceRoot: "/workspaces",
      },
      runtime,
    });

    await engine.stopSession(SANDBOX_SESSION_ID);
    await engine.stopAllSessions();

    expect(removeSession).toHaveBeenCalledWith({ force: true, v: true });
    expect(removeOrphan).toHaveBeenCalledWith({ force: true, v: true });
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
        googleWorkspaceCredentialsRoot: "/google-workspace-credentials",
        toolsRoot: "/tools",
        workspaceRoot: "/workspaces",
      },
      runtime,
    });

    await expect(engine.stopSession(SANDBOX_SESSION_ID)).resolves.toBeUndefined();
  });
});
