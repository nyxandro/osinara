/**
 * Pure Docker container configuration for Osinara sandboxes.
 *
 * Exports:
 * - `SandboxDockerRuntime`: resolved Docker resources owned by Compose.
 * - `SANDBOX_CONTAINER_POLICY_VERSION`: invalidates containers created under older runtime policy.
 * - `buildSandboxContainerOptions`: creates fail-closed scoped container options.
 * - `buildGoogleWorkspaceContainerOptions`: creates a one-shot credential boundary.
 * - `resolveTrustedToolMount`: selects the only persistent HOME mount for a trusted session.
 */
import type Docker from "dockerode";

import type {
  GoogleWorkspaceExecutionRequest,
  SandboxRunnerCreateRequest,
  SandboxRunnerMount,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";

export interface SandboxDockerRuntime {
  egressNetwork: string;
  image: string;
  project: string;
  toolsVolume: string;
  workspaceVolume: string;
}

export const SANDBOX_CONTAINER_POLICY_VERSION = "10";

const AGENT_BROWSER_SESSION_NAME = "osinara";
const AGENT_BROWSER_RESTORE_SAVE_POLICY = "auto";
const PROXY_URL = "http://sandbox-egress-proxy:3128";
const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const GOOGLE_WORKSPACE_BINARY = "/opt/osinara/gws";
const RUSSIAN_TRUSTED_ROOT_CA_PATH =
  "/usr/local/share/ca-certificates/russian-trusted-root-ca.crt";
const SANDBOX_CPU_NANOSECONDS = 1_000_000_000;
const SANDBOX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const SANDBOX_PIDS_LIMIT = 256;
const SANDBOX_SHM_BYTES = 256 * 1024 * 1024;

function volumeMount(source: string, target: string, subpath: string): Docker.MountSettings {
  // Docker Engine accepts Subpath without the optional driver fields over the HTTP API.
  return {
    Source: source,
    Target: target,
    Type: "volume",
    VolumeOptions: { Subpath: subpath },
  } as Docker.MountSettings;
}

function workspaceMounts(
  runtime: SandboxDockerRuntime,
  mounts: readonly SandboxRunnerMount[],
): Docker.MountSettings[] {
  return mounts.map((mount) =>
    volumeMount(runtime.workspaceVolume, `/workspace/${mount.mountPoint}`, mount.workspaceId)
  );
}

export function resolveTrustedToolMount(
  mounts: readonly SandboxRunnerMount[],
): SandboxRunnerMount {
  // Private sessions prefer personal state; family sessions have only their family mount.
  const primary = mounts.find((mount) => mount.mountPoint === "personal") ?? mounts[0];
  if (!primary || primary.mountPoint === "group") {
    throw new Error(
      "AGENT_SANDBOX_RUNNER_TOOL_SCOPE_INVALID: Trusted tool environment is missing",
    );
  }
  return primary;
}

export function resolveSandboxToolMount(request: SandboxRunnerCreateRequest): SandboxRunnerMount {
  if (request.access !== "group-tools") return resolveTrustedToolMount(request.mounts);
  if (request.mounts.length !== 1 || request.mounts[0]?.mountPoint !== "group") {
    throw new Error("AGENT_SANDBOX_RUNNER_SCOPE_INVALID: Group tools require one group workspace");
  }
  return request.mounts[0];
}

function toolsMount(
  runtime: SandboxDockerRuntime,
  mount: SandboxRunnerMount,
): Docker.MountSettings {
  return volumeMount(runtime.toolsVolume, `/tools/${mount.mountPoint}`, mount.workspaceId);
}

function toolsEnvironment(primary: SandboxRunnerMount): string[] {
  const root = `/tools/${primary.mountPoint}`;
  const executablePaths = [`${root}/npm/bin`, `${root}/python/bin`, `${root}/bin`];
  return [
    `AGENT_BROWSER_RESTORE=${AGENT_BROWSER_SESSION_NAME}`,
    `AGENT_BROWSER_RESTORE_SAVE=${AGENT_BROWSER_RESTORE_SAVE_POLICY}`,
    `AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION_NAME}`,
    `AGENT_BROWSER_PROXY=${PROXY_URL}`,
    "AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/osinara-chromium",
    `HOME=${root}/home`,
    `PATH=${[...executablePaths, BASE_PATH].join(":")}`,
    `NPM_CONFIG_PREFIX=${root}/npm`,
    `NODE_PATH=${root}/npm/lib/node_modules`,
    `NODE_EXTRA_CA_CERTS=${RUSSIAN_TRUSTED_ROOT_CA_PATH}`,
    "NODE_USE_ENV_PROXY=1",
    `PIP_CACHE_DIR=${root}/cache/pip`,
    `PLAYWRIGHT_BROWSERS_PATH=${root}/cache/ms-playwright`,
    `XDG_CACHE_HOME=${root}/cache`,
    `VIRTUAL_ENV=${root}/python`,
    `HTTP_PROXY=${PROXY_URL}`,
    `HTTPS_PROXY=${PROXY_URL}`,
    `http_proxy=${PROXY_URL}`,
    `https_proxy=${PROXY_URL}`,
    "NO_PROXY=localhost,127.0.0.1,sandbox-egress-proxy",
    "LANG=C.UTF-8",
  ];
}

function isolatedEnvironment(): string[] {
  return [
    "HOME=/tmp/home",
    `PATH=${BASE_PATH}`,
    "LANG=C.UTF-8",
  ];
}

export function buildSandboxContainerOptions(
  runtime: SandboxDockerRuntime,
  request: SandboxRunnerCreateRequest,
  groupNetwork?: string,
): Docker.ContainerCreateOptions {
  const trusted = request.access === "trusted";
  const toolsEnabled = request.access !== "restricted";
  if (request.access === "group-tools" && (!groupNetwork || groupNetwork === runtime.egressNetwork)) {
    throw new Error("AGENT_SANDBOX_GROUP_NETWORK_REQUIRED: External Bash requires a dedicated group network");
  }
  const toolMount = toolsEnabled ? resolveSandboxToolMount(request) : null;
  const mounts = workspaceMounts(runtime, request.mounts);
  if (toolMount) {
    mounts.push(toolsMount(runtime, toolMount));
  }

  return {
    AttachStderr: false,
    AttachStdin: false,
    AttachStdout: false,
    Cmd: ["sleep", "infinity"],
    Env: toolMount ? toolsEnvironment(toolMount) : isolatedEnvironment(),
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      // Docker's init process reaps Chromium descendants so durable sandboxes do not exhaust PIDs.
      Init: true,
      Memory: SANDBOX_MEMORY_BYTES,
      Mounts: mounts,
      NanoCpus: SANDBOX_CPU_NANOSECONDS,
      NetworkMode: trusted ? runtime.egressNetwork : request.access === "group-tools" ? groupNetwork : "none",
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Privileged: false,
      ReadonlyRootfs: false,
      SecurityOpt: ["no-new-privileges:true"],
      ShmSize: SANDBOX_SHM_BYTES,
      // The shared image contains gws, but durable model-controlled Bash must never see it.
      Tmpfs: {
        "/opt/osinara": "ro,noexec,nosuid,size=64k,mode=0555",
        "/tmp": "rw,noexec,nosuid,size=512m,mode=1777",
      },
    },
    Image: runtime.image,
    Labels: {
      "dev.osinara.sandbox.access": request.access,
      "dev.osinara.sandbox.agent-session-id": request.agentSessionId,
      "dev.osinara.sandbox.policy-version": SANDBOX_CONTAINER_POLICY_VERSION,
      "dev.osinara.sandbox.project": runtime.project,
      "dev.osinara.sandbox.session-id": request.sandboxSessionId,
      ...(request.access === "group-tools" ? { "dev.osinara.sandbox.group-workspace-id": request.mounts[0]!.workspaceId } : {}),
    },
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    WorkingDir: trusted ? "/workspace" : "/workspace/group",
  };
}

export function buildGoogleWorkspaceContainerOptions(
  runtime: SandboxDockerRuntime,
  request: GoogleWorkspaceExecutionRequest,
): Docker.ContainerCreateOptions {
  return {
    AttachStderr: true,
    AttachStdin: false,
    AttachStdout: true,
    Cmd: [GOOGLE_WORKSPACE_BINARY, ...request.argv],
    Env: [
      `GOOGLE_WORKSPACE_CLI_TOKEN=${request.accessToken}`,
      "HOME=/tmp",
      `HTTP_PROXY=${PROXY_URL}`,
      `HTTPS_PROXY=${PROXY_URL}`,
      "LANG=C.UTF-8",
      "NO_PROXY=localhost,127.0.0.1,sandbox-egress-proxy",
      `http_proxy=${PROXY_URL}`,
      `https_proxy=${PROXY_URL}`,
    ],
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      Init: true,
      Memory: SANDBOX_MEMORY_BYTES,
      Mounts: [volumeMount(runtime.workspaceVolume, "/workspace", request.workspaceId)],
      NanoCpus: SANDBOX_CPU_NANOSECONDS,
      NetworkMode: runtime.egressNetwork,
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Privileged: false,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m,mode=1777" },
    },
    Image: runtime.image,
    Labels: {
      "dev.osinara.google-workspace-execution": "true",
      "dev.osinara.sandbox.project": runtime.project,
    },
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    WorkingDir: "/workspace",
  };
}
