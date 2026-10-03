/**
 * The session sandbox on the isolated Osinara sandbox runner.
 *
 * Exports:
 * - `openRunnerSandbox`: a lazy runner session for one agent session. The first operation creates
 *   or reattaches its container; the folders a session mounted first stay its folders.
 * - `deleteRunnerToolEnvironment`: removes persistent tools when their workspace is deleted.
 *
 * Key constructs:
 * - Access follows the mounts: a group workspace runs restricted, personal/family run trusted, a
 *   session without mounts (silent memory review) has no compute at all.
 * - Stored metadata (`agent_session_state.sandbox_state`) restores the same
 *   container identity and mounts; compute itself is disposable, workspaces live on volumes.
 * - Skills arrive as one verified batch per turn (`syncSkills`); there are no build-time seed
 *   templates: the container starts empty and the turn syncs its skills before the first step.
 */
import { posix } from "node:path";

import type { Experimental_SandboxProcess } from "ai";

import { SANDBOX_RUNNER_BASE_URL } from "../../config.js";
import type { RuntimeSandboxSession, SandboxSkillPackage } from "../../runtime/sandbox/types.js";
import type {
  GroupSandboxCommandOptions,
  SandboxAccess,
  SandboxRunnerCreateRequest,
  WorkspaceSandboxUseOptions,
} from "./sandbox-runner-contract.js";
import { parseCreateSandboxRequest, parseWorkspaceSandboxUseOptions, sandboxSeedDigest } from "./sandbox-runner-contract.js";
import { SandboxRunnerClient } from "./runner-client.js";
import { withGroupSandboxAccess } from "./group-sandbox-policy.js";
import { accessForMounts, ROOT_RUNNER_PROFILE } from "./runner-sandbox-profile.js";
import { parseStoredSandboxMetadata, type StoredSandboxMetadata } from "./runner-sandbox-state.js";

const NO_SEED = { seedDigest: sandboxSeedDigest([]), seedFiles: [] };

function resolveSandboxPath(path: string): string {
  return path.startsWith("/") ? posix.normalize(path) : posix.resolve("/workspace", path);
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function resultStream(
  completion: Promise<{ stderr: string; stdout: string }>,
  field: "stderr" | "stdout",
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const value = (await completion)[field];
      if (value) controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function buildSession(input: {
  access: () => SandboxAccess | null;
  client: SandboxRunnerClient;
  ensure: (requiredCapability?: "bash") => Promise<{ sessionId: string; instanceId: string }>;
  id: () => string;
  stop: () => Promise<void>;
  syncSkills: (packages: readonly SandboxSkillPackage[], removed: readonly string[]) => Promise<void>;
}): RuntimeSandboxSession {
  async function spawn(options: GroupSandboxCommandOptions): Promise<Experimental_SandboxProcess> {
    const { sessionId, instanceId } = await input.ensure(options.requiredGroupCapability);
    const controller = new AbortController();
    let killed = false;
    const completion = input.client.run(sessionId, {
      command: options.command,
      expectedInstanceId: instanceId,
      environment: options.env,
      workingDirectory: options.workingDirectory,
    }, controller.signal).catch((error: unknown) => {
      if (killed) return { exitCode: 137, processId: "killed", stderr: "", stdout: "" };
      throw error;
    });
    options.abortSignal?.addEventListener("abort", () => controller.abort(), { once: true });
    return {
      stderr: resultStream(completion, "stderr"),
      stdout: resultStream(completion, "stdout"),
      async kill() {
        if (killed) return;
        killed = true;
        controller.abort();
        await input.client.stop(sessionId);
      },
      async wait() {
        return { exitCode: (await completion).exitCode };
      },
    };
  }

  async function readBytes(path: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    return await input.client.readFile((await input.ensure()).sessionId, resolveSandboxPath(path), signal);
  }

  async function writeBytes(path: string, content: Uint8Array, signal?: AbortSignal): Promise<void> {
    await input.client.writeFile((await input.ensure()).sessionId, resolveSandboxPath(path), content, signal);
  }

  return {
    stop: input.stop,
    syncSkills: input.syncSkills,
    get id() {
      return input.id();
    },
    resolvePath: resolveSandboxPath,
    async run(options: GroupSandboxCommandOptions) {
      const { sessionId, instanceId } = await input.ensure(options.requiredGroupCapability);
      const result = await input.client.run(sessionId, {
        command: options.command,
        expectedInstanceId: instanceId,
        environment: options.env,
        workingDirectory: options.workingDirectory,
      }, options.abortSignal);
      return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
    },
    spawn,
    async readFile(options) {
      const bytes = await readBytes(options.path, options.abortSignal);
      return bytes === null ? null : byteStream(bytes);
    },
    readBinaryFile: (options) => readBytes(options.path, options.abortSignal),
    async readTextFile(options) {
      const bytes = await readBytes(options.path, options.abortSignal);
      if (bytes === null) return null;
      const encoding = options.encoding ?? "utf8";
      if (!Buffer.isEncoding(encoding)) {
        throw new Error("AGENT_SANDBOX_RUNNER_ENCODING_INVALID: File encoding is unsupported");
      }
      const text = Buffer.from(bytes).toString(encoding);
      if (options.startLine === undefined && options.endLine === undefined) return text;
      const lines = text.match(/.*(?:\r\n|\n|\r|$)/gu)?.filter(Boolean) ?? [];
      return lines.slice((options.startLine ?? 1) - 1, options.endLine).join("");
    },
    async writeFile(options) {
      await writeBytes(options.path, await streamBytes(options.content), options.abortSignal);
    },
    writeBinaryFile: (options) => writeBytes(options.path, options.content, options.abortSignal),
    async writeTextFile(options) {
      const encoding = options.encoding ?? "utf8";
      if (!Buffer.isEncoding(encoding)) {
        throw new Error("AGENT_SANDBOX_RUNNER_ENCODING_INVALID: File encoding is unsupported");
      }
      await writeBytes(options.path, Buffer.from(options.content, encoding), options.abortSignal);
    },
    async removePath(options) {
      await input.client.removePath((await input.ensure()).sessionId, {
        force: options.force,
        path: resolveSandboxPath(options.path),
        recursive: options.recursive,
      }, options.abortSignal);
    },
    async setNetworkPolicy(policy) {
      const access = input.access();
      const valid = (access === "trusted" && policy === "allow-all") ||
        (access !== "trusted" && access !== null && policy === "deny-all");
      if (!valid) {
        throw new Error(
          "AGENT_SANDBOX_RUNNER_NETWORK_POLICY_FORBIDDEN: Session network policy is immutable",
        );
      }
    },
  };
}

export interface RunnerSandbox {
  readonly session: RuntimeSandboxSession;
  /** What to store for the session: its container identity, mounts and access. */
  captureState(): StoredSandboxMetadata;
}

function remountDenied(): Error {
  return new Error("AGENT_SANDBOX_RUNNER_REMOUNT_DENIED: Session mounts are immutable");
}

// A stored session keeps its folders: a different mount set or container identity is refused.
function requireSameMounts(restored: StoredSandboxMetadata, use: WorkspaceSandboxUseOptions): void {
  if (restored.sandboxSessionId !== use.sandboxSessionId) throw remountDenied();
  if (restored.disabled ? use.mounts.length !== 0 : JSON.stringify(restored.mounts) !== JSON.stringify(use.mounts)) {
    throw remountDenied();
  }
}

export function openRunnerSandbox(input: {
  readonly baseUrl?: string;
  /** The agent session id; the runner records it with the container. */
  readonly sessionId: string;
  readonly stored: Record<string, unknown> | null;
  /** What the session mounts now, from its verified authorization. */
  readonly use: WorkspaceSandboxUseOptions;
}): RunnerSandbox {
  const profile = ROOT_RUNNER_PROFILE;
  const client = new SandboxRunnerClient(input.baseUrl ?? SANDBOX_RUNNER_BASE_URL);
  const use = parseWorkspaceSandboxUseOptions(input.use);
  const restored = parseStoredSandboxMetadata(input.stored ?? undefined, input.sessionId, profile.stateSchemaVersion);
  if (restored !== null) requireSameMounts(restored, use);
  const disabled = use.mounts.length === 0;
  let request: SandboxRunnerCreateRequest | null = disabled ? null : (() => {
    const access = accessForMounts(use.mounts);
    return parseCreateSandboxRequest({ access, agentSessionId: input.sessionId, mounts: use.mounts, sandboxSessionId: use.sandboxSessionId, ...NO_SEED });
  })();
  if (restored !== null && !restored.disabled && request !== null) {
    request = parseCreateSandboxRequest({ ...request, access: restored.access });
  }
  const requireRequest = (): SandboxRunnerCreateRequest => {
    if (request === null) throw new Error("AGENT_SANDBOX_RUNNER_SESSION_DISABLED: Sandbox access is disabled for this session");
    return request;
  };
  const ensureWithAccess = async (access: SandboxAccess): Promise<{ sessionId: string; instanceId: string }> => {
    let current = requireRequest();
    if (current.access !== access) {
      request = parseCreateSandboxRequest({ ...current, access, ...NO_SEED });
      current = request;
    }
    let probe = await client.create({ ...current, seedFiles: undefined });
    if (probe.seedRequired) {
      probe = await client.create(current);
      if (probe.seedRequired) throw new Error("AGENT_SANDBOX_RUNNER_SEED_REQUIRED: Runner rejected the seed bundle");
    }
    if (!probe.instanceId) throw new Error("AGENT_SANDBOX_RUNNER_INSTANCE_MISSING: Runner did not identify the active container");
    return { sessionId: current.sandboxSessionId, instanceId: probe.instanceId };
  };
  const groupMount = () => requireRequest().mounts.find((mount) => mount.mountPoint === "group");
  const ensureRunner = async (requiredCapability?: "bash") => {
    const group = groupMount();
    return group ? withGroupSandboxAccess(group.workspaceId, ensureWithAccess, requiredCapability) : ensureWithAccess("trusted");
  };
  const session = buildSession({
    access: () => request?.access ?? null,
    client,
    ensure: ensureRunner,
    id: () => use.sandboxSessionId,
    // The runner operation is idempotent; a session without compute has nothing to stop.
    stop: async () => { if (request !== null) await client.stop(request.sandboxSessionId); },
    async syncSkills(packages, removed) {
      if (packages.length === 0 && removed.length === 0) return;
      const started = performance.now();
      const sync = async (access: SandboxAccess) => {
        const { sessionId, instanceId } = await ensureWithAccess(access);
        return client.syncSkills(sessionId, { expectedInstanceId: instanceId,
          packages: packages.map((pkg) => ({ name: pkg.name, files: pkg.files.map((file) => ({
            path: file.relativePath, contentBase64: Buffer.from(file.content).toString("base64"),
          })) })), removed: [...removed],
        });
      };
      const group = groupMount();
      const result = group
        ? await withGroupSandboxAccess(group.workspaceId, sync, undefined, packages.map((pkg) => pkg.name))
        : await sync("trusted");
      console.info(JSON.stringify({ code: "AGENT_SKILL_SYNC_METRICS", sessionId: input.sessionId,
        durationMs: Math.round(performance.now() - started), ...result }));
    },
  });
  return {
    session,
    captureState() {
      if (request === null) {
        return { disabled: true, mounts: [], sandboxSessionId: use.sandboxSessionId, version: profile.stateSchemaVersion };
      }
      return { access: request.access, disabled: false, mounts: request.mounts, sandboxSessionId: request.sandboxSessionId, version: profile.stateSchemaVersion };
    },
  };
}

export async function deleteRunnerToolEnvironment(
  workspaceId: string,
  baseUrl = SANDBOX_RUNNER_BASE_URL,
): Promise<void> {
  await new SandboxRunnerClient(baseUrl).deleteToolEnvironment(workspaceId);
}
