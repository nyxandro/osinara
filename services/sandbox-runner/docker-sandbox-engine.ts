/**
 * Docker-backed implementation of the private sandbox runner engine.
 *
 * Exports:
 * - `buildSandboxContainerOptions`: re-exported pure container policy builder.
 * - `createDockerSandboxEngine`: durable scoped container lifecycle and I/O.
 * - `resolveSandboxDockerRuntime`: discovers Compose-owned volumes/network fail-fast.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import { posix } from "node:path";

import Docker from "dockerode";
import * as tar from "tar-stream";

import {
  SANDBOX_RUNNER_MAX_OUTPUT_BYTES,
  SANDBOX_RUNNER_TIMEOUT_MAX_MS,
  type SandboxRunnerCreateRequest,
  type SandboxRunnerProcessRequest,
  type SandboxRunnerProcessResponse,
  type SandboxRunnerRemovePathRequest,
  type SandboxRunnerSessionResponse,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import { WORKSPACE_MAX_FILE_BYTES } from "../../agent/config.js";
import type { SandboxEngine } from "./sandbox-engine.js";
import {
  buildSandboxContainerOptions,
  type SandboxDockerRuntime,
} from "./docker-sandbox-options.js";

export { buildSandboxContainerOptions } from "./docker-sandbox-options.js";

const CONTAINER_PREFIX = "osinara-sandbox-";
const MOUNT_TOOLS_DESTINATION = "/runner/tools";
const MOUNT_WORKSPACES_DESTINATION = "/runner/workspaces";
const SANDBOX_IMAGE = "osinara-sandbox-runtime:local";
const SANDBOX_NETWORK_LABEL = "sandbox-egress";
const PROCESS_DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const STOP_TIMEOUT_SECONDS = 10;
const SANDBOX_SESSION_LABEL = "dev.osinara.sandbox.session-id";
const SANDBOX_PROJECT_LABEL = "dev.osinara.sandbox.project";
const SANDBOX_EVE_SESSION_LABEL = "dev.osinara.sandbox.eve-session-id";

interface RunnerMount {
  Destination?: string;
  Name?: string;
}

interface RuntimeRoots {
  toolsRoot: string;
  workspaceRoot: string;
}

function dockerStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

function containerName(sessionId: string): string {
  // Keep Docker names bounded even when Eve's opaque backend key reaches its 120-character limit.
  const id = createHash("sha256").update(sessionId).digest("hex").slice(0, 40);
  return `${CONTAINER_PREFIX}${id}`;
}

function requestHash(request: SandboxRunnerCreateRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function resolvePath(path: string): string {
  const normalized = path.startsWith("/") ? posix.normalize(path) : posix.resolve("/workspace", path);
  const allowed = ["/tmp", "/tools", "/workspace"].some((root) =>
    normalized === root || normalized.startsWith(`${root}/`)
  );
  if (!allowed) {
    throw new Error("AGENT_SANDBOX_RUNNER_PATH_INVALID: Path is outside sandbox writable roots");
  }
  return normalized;
}

async function requireDirectory(path: string, code: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`${code}: Required path is not a directory`);
}

async function collectStream(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) {
      stream.destroy(new Error("AGENT_SANDBOX_RUNNER_OUTPUT_TOO_LARGE: Process output exceeds limit"));
      throw new Error("AGENT_SANDBOX_RUNNER_OUTPUT_TOO_LARGE: Process output exceeds limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function execute(
  docker: Docker,
  container: Docker.Container,
  request: SandboxRunnerProcessRequest,
  signal?: AbortSignal,
): Promise<SandboxRunnerProcessResponse> {
  const timeoutMs = request.timeoutMs ?? PROCESS_DEFAULT_TIMEOUT_MS;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const exec = await container.exec({
    AttachStderr: true,
    AttachStdout: true,
    Cmd: ["timeout", "--signal=KILL", String(timeoutSeconds), "bash", "-c", request.command],
    Env: request.environment
      ? Object.entries(request.environment).map(([name, value]) => `${name}=${value}`)
      : undefined,
    Tty: false,
    WorkingDir: request.workingDirectory ? resolvePath(request.workingDirectory) : "/workspace",
  });
  let stream: NodeJS.ReadWriteStream;
  try {
    stream = await exec.start({ Tty: false, abortSignal: signal });
  } catch (error) {
    await container.stop({ t: 0 }).catch(() => undefined);
    throw error;
  }
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  stream.once("end", () => {
    stdout.end();
    stderr.end();
  });
  stream.once("error", (error) => {
    stdout.destroy(error);
    stderr.destroy(error);
  });
  let stdoutBytes: Buffer;
  let stderrBytes: Buffer;
  try {
    [stdoutBytes, stderrBytes] = await Promise.all([
      collectStream(stdout, SANDBOX_RUNNER_MAX_OUTPUT_BYTES),
      collectStream(stderr, SANDBOX_RUNNER_MAX_OUTPUT_BYTES),
    ]);
  } catch (error) {
    // Aborted or oversized commands must not keep running detached inside a durable session.
    await container.stop({ t: 0 }).catch(() => undefined);
    throw error;
  }
  const inspection = await exec.inspect();
  if (inspection.Running || inspection.ExitCode === null) {
    throw new Error("AGENT_SANDBOX_RUNNER_PROCESS_STATE_INVALID: Process did not terminate");
  }
  return {
    exitCode: inspection.ExitCode,
    processId: randomUUID(),
    stderr: stderrBytes.toString("utf8"),
    stdout: stdoutBytes.toString("utf8"),
  };
}

async function ensureToolDirectories(
  docker: Docker,
  container: Docker.Container,
  request: SandboxRunnerCreateRequest,
): Promise<void> {
  if (request.access !== "trusted") return;
  const directories = request.mounts.flatMap((mount) => {
    const root = `/tools/${mount.mountPoint}`;
    return [`${root}/bin`, `${root}/cache`, `${root}/home`, `${root}/npm`];
  });
  const pythonEnvironments = request.mounts.map((mount) => `/tools/${mount.mountPoint}/python`);
  const initializePython = pythonEnvironments.map((python) =>
    `(test -x ${JSON.stringify(`${python}/bin/python`)} || python3 -m venv ${JSON.stringify(python)})`
  );
  const command = [
    `mkdir -p ${directories.map((path) => JSON.stringify(path)).join(" ")}`,
    ...initializePython,
  ].join(" && ");
  const result = await execute(docker, container, {
    command,
    timeoutMs: SANDBOX_RUNNER_TIMEOUT_MAX_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`AGENT_SANDBOX_RUNNER_TOOL_ENV_INIT_FAILED: ${result.stderr}`);
  }
}

async function readArchiveFile(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  return await new Promise((resolve, reject) => {
    const extract = tar.extract();
    let content: Buffer | null = null;
    let entries = 0;
    extract.on("entry", (header, entry, next) => {
      entries += 1;
      if (entries > 1 || header.type !== "file") {
        entry.resume();
        reject(new Error("AGENT_SANDBOX_RUNNER_ARCHIVE_INVALID: Expected one regular file"));
        return;
      }
      void collectStream(entry, WORKSPACE_MAX_FILE_BYTES).then((bytes) => {
        content = bytes;
        next();
      }, reject);
    });
    extract.on("finish", () => {
      if (content === null) reject(new Error("AGENT_SANDBOX_RUNNER_ARCHIVE_INVALID: File is absent"));
      else resolve(content);
    });
    extract.on("error", reject);
    stream.on("error", reject);
    stream.pipe(extract);
  });
}

async function writeArchiveFile(
  container: Docker.Container,
  path: string,
  content: Uint8Array,
): Promise<void> {
  if (content.byteLength > WORKSPACE_MAX_FILE_BYTES) {
    throw new Error("AGENT_SANDBOX_RUNNER_FILE_TOO_LARGE: File exceeds the 50 MB limit");
  }
  const directory = posix.dirname(path);
  const pack = tar.pack();
  pack.entry({ mode: 0o600, name: posix.basename(path), type: "file" }, Buffer.from(content));
  pack.finalize();
  await container.putArchive(pack, { path: directory });
}

async function inspectContainer(
  docker: Docker,
  sessionId: string,
): Promise<{ container: Docker.Container; inspection: Docker.ContainerInspectInfo } | null> {
  const container = docker.getContainer(containerName(sessionId));
  try {
    return { container, inspection: await container.inspect() };
  } catch (error) {
    if (dockerStatus(error) === 404) return null;
    throw error;
  }
}

export function createDockerSandboxEngine(input: {
  docker: Docker;
  roots: RuntimeRoots;
  runtime: SandboxDockerRuntime;
}): SandboxEngine {
  return {
    async health() {
      await input.docker.ping();
      await input.docker.getImage(input.runtime.image).inspect();
    },
    async createSession(request): Promise<SandboxRunnerSessionResponse> {
      for (const mount of request.mounts) {
        await mkdir(`${input.roots.workspaceRoot}/${mount.workspaceId}`, { recursive: true });
        await requireDirectory(
          `${input.roots.workspaceRoot}/${mount.workspaceId}`,
          "AGENT_SANDBOX_RUNNER_WORKSPACE_MISSING",
        );
        if (request.access === "trusted") {
          const toolsPath = `${input.roots.toolsRoot}/${mount.workspaceId}`;
          await mkdir(toolsPath, { recursive: true });
          await requireDirectory(toolsPath, "AGENT_SANDBOX_RUNNER_TOOLS_MISSING");
        }
      }

      const existing = await inspectContainer(input.docker, request.sessionId);
      if (existing) {
        const hash = existing.inspection.Config.Labels?.["dev.osinara.sandbox.request-hash"];
        if (hash !== requestHash(request)) {
          throw new Error("AGENT_SANDBOX_RUNNER_SESSION_MISMATCH: Persisted scope differs");
        }
        if (!existing.inspection.State.Running) await existing.container.start();
        return { created: false, sessionId: request.sessionId };
      }

      const options = buildSandboxContainerOptions(input.runtime, request);
      options.name = containerName(request.sessionId);
      options.Labels = {
        ...options.Labels,
        "dev.osinara.sandbox.request-hash": requestHash(request),
      };
      const container = await input.docker.createContainer(options);
      try {
        await container.start();
        await ensureToolDirectories(input.docker, container, request);
      } catch (error) {
        await container.remove({ force: true }).catch(() => undefined);
        throw error;
      }
      return { created: true, sessionId: request.sessionId };
    },
    async runProcess(sessionId, request, signal) {
      const existing = await inspectContainer(input.docker, sessionId);
      if (!existing) throw new Error("AGENT_SANDBOX_RUNNER_SESSION_NOT_FOUND: Sandbox is absent");
      if (!existing.inspection.State.Running) await existing.container.start();
      return await execute(input.docker, existing.container, request, signal);
    },
    async readFile(sessionId, path) {
      const existing = await inspectContainer(input.docker, sessionId);
      if (!existing) throw new Error("AGENT_SANDBOX_RUNNER_SESSION_NOT_FOUND: Sandbox is absent");
      try {
        return await readArchiveFile(await existing.container.getArchive({ path: resolvePath(path) }));
      } catch (error) {
        if (dockerStatus(error) === 404) return null;
        throw error;
      }
    },
    async writeFile(sessionId, path, content) {
      const existing = await inspectContainer(input.docker, sessionId);
      if (!existing) throw new Error("AGENT_SANDBOX_RUNNER_SESSION_NOT_FOUND: Sandbox is absent");
      const resolved = resolvePath(path);
      const directoryResult = await execute(input.docker, existing.container, {
        command: `mkdir -p -- ${JSON.stringify(posix.dirname(resolved))}`,
      });
      if (directoryResult.exitCode !== 0) {
        throw new Error(`AGENT_SANDBOX_RUNNER_DIRECTORY_CREATE_FAILED: ${directoryResult.stderr}`);
      }
      await writeArchiveFile(existing.container, resolved, content);
    },
    async removePath(sessionId, request: SandboxRunnerRemovePathRequest) {
      const existing = await inspectContainer(input.docker, sessionId);
      if (!existing) throw new Error("AGENT_SANDBOX_RUNNER_SESSION_NOT_FOUND: Sandbox is absent");
      const args = ["rm"];
      if (request.force) args.push("-f");
      if (request.recursive) args.push("-r");
      args.push("--", resolvePath(request.path));
      const exec = await existing.container.exec({
        AttachStderr: true,
        AttachStdout: true,
        Cmd: args,
        Tty: false,
      });
      await collectStream(await exec.start({ Tty: false }), SANDBOX_RUNNER_MAX_OUTPUT_BYTES);
      const inspection = await exec.inspect();
      if (inspection.ExitCode !== 0) {
        throw new Error("AGENT_SANDBOX_RUNNER_REMOVE_FAILED: Could not remove sandbox path");
      }
    },
    async stopSession(sessionId) {
      const existing = await inspectContainer(input.docker, sessionId);
      if (existing?.inspection.State.Running) {
        await existing.container.stop({ t: STOP_TIMEOUT_SECONDS });
      }
    },
    async stopAllSessions() {
      const containers = await input.docker.listContainers({
        all: true,
        filters: {
          label: [SANDBOX_SESSION_LABEL, `${SANDBOX_PROJECT_LABEL}=${input.runtime.project}`],
        },
      });
      await Promise.all(containers.filter((container) => container.State === "running").map(async (item) => {
        await input.docker.getContainer(item.Id).stop({ t: STOP_TIMEOUT_SECONDS }).catch((error) => {
          if (dockerStatus(error) !== 304) throw error;
        });
      }));
    },
    async deleteSession(sessionId) {
      const existing = await inspectContainer(input.docker, sessionId);
      if (existing) await existing.container.remove({ force: true, v: true });
    },
    async deleteEveSession(eveSessionId) {
      // Retention knows the durable Eve ID, so remove every root/subagent sandbox carrying its label.
      const containers = await input.docker.listContainers({
        all: true,
        filters: {
          label: [
            `${SANDBOX_EVE_SESSION_LABEL}=${eveSessionId}`,
            `${SANDBOX_PROJECT_LABEL}=${input.runtime.project}`,
          ],
        },
      });
      await Promise.all(containers.map(async (container) => {
        await input.docker.getContainer(container.Id).remove({ force: true, v: true });
      }));
    },
    async deleteToolEnvironment(workspaceId) {
      await rm(`${input.roots.toolsRoot}/${workspaceId}`, { force: true, recursive: true });
    },
  };
}

export async function resolveSandboxDockerRuntime(docker: Docker): Promise<{
  roots: RuntimeRoots;
  runtime: SandboxDockerRuntime;
}> {
  const runnerId = process.env.HOSTNAME;
  if (!runnerId) throw new Error("AGENT_SANDBOX_RUNNER_HOSTNAME_MISSING: Container ID is required");
  const inspection = await docker.getContainer(runnerId).inspect();
  const mounts = inspection.Mounts as RunnerMount[];
  const workspaceVolume = mounts.find((mount) => mount.Destination === MOUNT_WORKSPACES_DESTINATION)?.Name;
  const toolsVolume = mounts.find((mount) => mount.Destination === MOUNT_TOOLS_DESTINATION)?.Name;
  if (!workspaceVolume || !toolsVolume) {
    throw new Error("AGENT_SANDBOX_RUNNER_VOLUME_MISSING: Compose volumes are not mounted");
  }

  const composeProject = inspection.Config.Labels?.["com.docker.compose.project"];
  if (!composeProject) {
    throw new Error("AGENT_SANDBOX_RUNNER_PROJECT_MISSING: Compose project label is absent");
  }
  const networks = await docker.listNetworks({
    filters: {
      label: [
        `com.docker.compose.network=${SANDBOX_NETWORK_LABEL}`,
        `com.docker.compose.project=${composeProject}`,
      ],
    },
  });
  const egressNetwork = networks.length === 1 ? networks[0]!.Name : null;
  if (!egressNetwork) {
    throw new Error("AGENT_SANDBOX_RUNNER_NETWORK_MISSING: Egress network is not uniquely resolved");
  }

  return {
    roots: {
      toolsRoot: MOUNT_TOOLS_DESTINATION,
      workspaceRoot: MOUNT_WORKSPACES_DESTINATION,
    },
    runtime: {
      egressNetwork,
      image: SANDBOX_IMAGE,
      project: composeProject,
      toolsVolume,
      workspaceVolume,
    },
  };
}
