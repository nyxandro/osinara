/**
 * Pure Docker container configuration for Osinara sandboxes.
 *
 * Exports:
 * - `SandboxDockerRuntime`: resolved Docker resources owned by Compose.
 * - `buildSandboxContainerOptions`: creates fail-closed scoped container options.
 */
import type Docker from "dockerode";

import type {
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

const PROXY_URL = "http://sandbox-egress-proxy:3128";
const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
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

function toolsMounts(
  runtime: SandboxDockerRuntime,
  mounts: readonly SandboxRunnerMount[],
): Docker.MountSettings[] {
  return mounts.map((mount) =>
    volumeMount(runtime.toolsVolume, `/tools/${mount.mountPoint}`, mount.workspaceId)
  );
}

function trustedEnvironment(mounts: readonly SandboxRunnerMount[]): string[] {
  const primary = mounts.find((mount) => mount.mountPoint === "personal") ?? mounts[0]!;
  const root = `/tools/${primary.mountPoint}`;
  const executablePaths = mounts.flatMap((mount) => [
    `/tools/${mount.mountPoint}/npm/bin`,
    `/tools/${mount.mountPoint}/python/bin`,
    `/tools/${mount.mountPoint}/bin`,
  ]);
  return [
    `HOME=${root}/home`,
    `PATH=${[...executablePaths, BASE_PATH].join(":")}`,
    `NPM_CONFIG_PREFIX=${root}/npm`,
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

function restrictedEnvironment(): string[] {
  return [
    "HOME=/tmp/home",
    `PATH=${BASE_PATH}`,
    "LANG=C.UTF-8",
  ];
}

export function buildSandboxContainerOptions(
  runtime: SandboxDockerRuntime,
  request: SandboxRunnerCreateRequest,
): Docker.ContainerCreateOptions {
  const trusted = request.access === "trusted";
  const mounts = workspaceMounts(runtime, request.mounts);
  if (trusted) mounts.push(...toolsMounts(runtime, request.mounts));

  return {
    AttachStderr: false,
    AttachStdin: false,
    AttachStdout: false,
    Cmd: ["sleep", "infinity"],
    Env: trusted ? trustedEnvironment(request.mounts) : restrictedEnvironment(),
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      Memory: SANDBOX_MEMORY_BYTES,
      Mounts: mounts,
      NanoCpus: SANDBOX_CPU_NANOSECONDS,
      NetworkMode: trusted ? runtime.egressNetwork : "none",
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Privileged: false,
      ReadonlyRootfs: false,
      SecurityOpt: ["no-new-privileges:true"],
      ShmSize: SANDBOX_SHM_BYTES,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=512m,mode=1777" },
    },
    Image: runtime.image,
    Labels: {
      "dev.osinara.sandbox.access": request.access,
      "dev.osinara.sandbox.eve-session-id": request.eveSessionId,
      "dev.osinara.sandbox.project": runtime.project,
      "dev.osinara.sandbox.session-id": request.sessionId,
    },
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    WorkingDir: "/workspace",
  };
}
