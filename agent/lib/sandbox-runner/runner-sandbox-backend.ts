/**
 * Eve backend for the isolated Osinara sandbox runner.
 *
 * Exports:
 * - `scopedWorkspaceRunner`: real-Bash backend with trusted scoped tools persistence.
 * - `deleteRunnerToolEnvironment`: removes persistent tools when their workspace is deleted.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import type {
  SandboxBackend,
  SandboxBackendPrewarmInput,
  SandboxProcess,
  SandboxSeedFile,
  SandboxSession,
  SandboxSpawnOptions,
} from "eve/sandbox";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";

import { SANDBOX_RUNNER_BASE_URL } from "../../config.js";
import type {
  SandboxAccess,
  SandboxRunnerCreateRequest,
  WorkspaceSandboxMount,
  WorkspaceSandboxUseOptions,
} from "./sandbox-runner-contract.js";
import {
  parseCreateSandboxRequest,
  parseSandboxEveSessionId,
} from "./sandbox-runner-contract.js";
import { SandboxRunnerClient } from "./runner-client.js";

const BACKEND_NAME = "osinara-scoped-runner-v3";
const CACHE_DIRECTORY = "osinara-scoped-runner";
const BACKEND_STATE_SCHEMA_VERSION = 3;
const TEMPLATE_SCHEMA_VERSION = 1;

interface BackendOptions {
  baseUrl?: string;
}

interface StoredTemplate {
  files: Array<{ contentBase64: string; path: string }>;
  version: number;
}

interface StoredBackendMetadata {
  access: SandboxAccess;
  mounts: WorkspaceSandboxMount[];
  sandboxSessionId: string;
  version: number;
}

function parseBackendMetadata(
  value: Record<string, unknown> | undefined,
  eveSessionId: string,
): StoredBackendMetadata | null {
  if (!value) return null;
  if (value.version !== BACKEND_STATE_SCHEMA_VERSION) {
    throw new Error("AGENT_SANDBOX_RUNNER_STATE_INVALID: Reconnect schema mismatch");
  }
  const request = parseCreateSandboxRequest({
    access: value.access,
    eveSessionId,
    mounts: value.mounts,
    sandboxSessionId: value.sandboxSessionId,
  });
  return {
    access: request.access,
    mounts: request.mounts,
    sandboxSessionId: request.sandboxSessionId,
    version: BACKEND_STATE_SCHEMA_VERSION,
  };
}

function templatePath(appRoot: string, templateKey: string): string {
  return join(appRoot, ".eve", "sandbox-cache", CACHE_DIRECTORY, "templates", `${templateKey}.json`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function encodeTemplate(seedFiles: ReadonlyArray<SandboxSeedFile>): StoredTemplate {
  return {
    files: seedFiles.map((file) => ({
      contentBase64: Buffer.from(file.content).toString("base64"),
      path: file.path,
    })),
    version: TEMPLATE_SCHEMA_VERSION,
  };
}

async function loadTemplate(appRoot: string, templateKey: string): Promise<StoredTemplate> {
  const path = templatePath(appRoot, templateKey);
  if (!await exists(path)) {
    throw new SandboxTemplateNotProvisionedError({ backendName: BACKEND_NAME, templateKey });
  }
  const template = JSON.parse(await readFile(path, "utf8")) as StoredTemplate;
  if (template.version !== TEMPLATE_SCHEMA_VERSION || !Array.isArray(template.files)) {
    throw new Error("AGENT_SANDBOX_RUNNER_TEMPLATE_INVALID: Template schema mismatch");
  }
  return template;
}

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

function accessForMounts(mounts: readonly WorkspaceSandboxMount[]): SandboxAccess {
  const hasGroup = mounts.some((mount) => mount.mountPoint === "group");
  const hasTrusted = mounts.some((mount) => mount.mountPoint !== "group");
  if (hasGroup === hasTrusted) {
    throw new Error("AGENT_SANDBOX_RUNNER_SCOPE_INVALID: Mixed or empty workspace mounts");
  }
  return hasGroup ? "restricted" : "trusted";
}

function sandboxHome(access: SandboxAccess, mounts: readonly WorkspaceSandboxMount[]): string {
  if (access === "restricted") return "/tmp/home";
  const primary = mounts.find((mount) => mount.mountPoint === "personal") ?? mounts[0];
  if (!primary || primary.mountPoint === "group") {
    throw new Error("AGENT_SANDBOX_RUNNER_SCOPE_INVALID: Trusted home scope is missing");
  }
  return `/tools/${primary.mountPoint}/home`;
}

function resolveSeedPath(
  path: string,
  access: SandboxAccess,
  mounts: readonly WorkspaceSandboxMount[],
): string {
  const homePrefix = "$HOME/";
  if (path.startsWith(homePrefix)) return `${sandboxHome(access, mounts)}/${path.slice(homePrefix.length)}`;
  if (path.startsWith("$HOME")) {
    throw new Error("AGENT_SANDBOX_RUNNER_SEED_PATH_INVALID: HOME seed path is malformed");
  }
  return resolveSandboxPath(path);
}

function buildSession(input: {
  access: () => SandboxAccess | null;
  client: SandboxRunnerClient;
  ensure: () => Promise<string>;
  id: () => string;
}): SandboxSession {
  async function spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
    const sessionId = await input.ensure();
    const controller = new AbortController();
    let killed = false;
    const completion = input.client.run(sessionId, {
      command: options.command,
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
    return await input.client.readFile(await input.ensure(), resolveSandboxPath(path), signal);
  }

  async function writeBytes(path: string, content: Uint8Array, signal?: AbortSignal): Promise<void> {
    await input.client.writeFile(await input.ensure(), resolveSandboxPath(path), content, signal);
  }

  return {
    get id() {
      return input.id();
    },
    resolvePath: resolveSandboxPath,
    async run(options) {
      const result = await input.client.run(await input.ensure(), {
        command: options.command,
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
      await input.client.removePath(await input.ensure(), {
        force: options.force,
        path: resolveSandboxPath(options.path),
        recursive: options.recursive,
      }, options.abortSignal);
    },
    async setNetworkPolicy(policy) {
      const access = input.access();
      const valid = (access === "trusted" && policy === "allow-all") ||
        (access === "restricted" && policy === "deny-all");
      if (!valid) {
        throw new Error(
          "AGENT_SANDBOX_RUNNER_NETWORK_POLICY_FORBIDDEN: Session network policy is immutable",
        );
      }
    },
  };
}

export function scopedWorkspaceRunner(options: BackendOptions = {}): SandboxBackend<
  Record<string, never>,
  WorkspaceSandboxUseOptions
> {
  const client = new SandboxRunnerClient(options.baseUrl ?? SANDBOX_RUNNER_BASE_URL);
  return {
    name: BACKEND_NAME,
    async prewarm(input: SandboxBackendPrewarmInput<Record<string, never>>) {
      if (input.bootstrap) {
        throw new Error("AGENT_SANDBOX_RUNNER_BOOTSTRAP_UNSUPPORTED: Use Eve seed files");
      }
      const path = templatePath(input.runtimeContext.appRoot, input.templateKey);
      if (await exists(path)) return { reused: true };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(encodeTemplate(input.seedFiles)), { flag: "wx" });
      return { reused: false };
    },
    async create(input) {
      const template = input.templateKey === null
        ? null
        : await loadTemplate(input.runtimeContext.appRoot, input.templateKey);
      // A thread ID survives normal context rotation while a trust-zone replacement gets a new ID.
      const eveSessionId = parseSandboxEveSessionId(input.tags?.sessionId);
      const restored = parseBackendMetadata(input.existingMetadata, eveSessionId);
      let request: SandboxRunnerCreateRequest | null = restored
        ? {
          access: restored.access,
          eveSessionId,
          mounts: restored.mounts,
          sandboxSessionId: restored.sandboxSessionId,
        }
        : null;
      const requireRequest = (): SandboxRunnerCreateRequest => {
        if (!request) {
          throw new Error(
            "AGENT_SANDBOX_RUNNER_SESSION_MISSING: Sandbox session is not mounted",
          );
        }
        return request;
      };
      const runnerSessionId = () => {
        return requireRequest().sandboxSessionId;
      };
      const ensureRunner = async (): Promise<string> => {
        const current = requireRequest();
        const created = await client.create(current);
        if (created.created) {
          try {
            for (const file of template?.files ?? []) {
              await client.writeFile(
                current.sandboxSessionId,
                resolveSeedPath(file.path, current.access, current.mounts),
                Buffer.from(file.contentBase64, "base64"),
              );
            }
          } catch (error) {
            // A partially seeded disposable container must not suppress seeding on recreation.
            await client.stop(current.sandboxSessionId);
            throw error;
          }
        }
        return current.sandboxSessionId;
      };
      const session = buildSession({
        access: () => request?.access ?? null,
        client,
        ensure: ensureRunner,
        id: runnerSessionId,
      });
      return {
        session,
        async useSessionFn(useOptions) {
          if (!useOptions) throw new Error("AGENT_SANDBOX_RUNNER_MOUNTS_MISSING: Mounts are required");
          if (request) {
            if (
              request.sandboxSessionId !== useOptions.sandboxSessionId ||
              JSON.stringify(request.mounts) !== JSON.stringify(useOptions.mounts)
            ) {
              throw new Error("AGENT_SANDBOX_RUNNER_REMOUNT_DENIED: Session mounts are immutable");
            }
            await ensureRunner();
            return session;
          }
          request = parseCreateSandboxRequest({
            access: accessForMounts(useOptions.mounts),
            eveSessionId,
            mounts: useOptions.mounts,
            sandboxSessionId: useOptions.sandboxSessionId,
          });
          await ensureRunner();
          return session;
        },
        async captureState() {
          const current = requireRequest();
          return {
            backendName: BACKEND_NAME,
            metadata: {
              access: current.access,
              mounts: current.mounts,
              sandboxSessionId: current.sandboxSessionId,
              version: BACKEND_STATE_SCHEMA_VERSION,
            },
            sessionKey: input.sessionKey,
          };
        },
        async shutdown() {
          if (request) await client.stop(request.sandboxSessionId);
        },
      };
    },
  };
}

export async function deleteRunnerToolEnvironment(
  workspaceId: string,
  baseUrl = SANDBOX_RUNNER_BASE_URL,
): Promise<void> {
  await new SandboxRunnerClient(baseUrl).deleteToolEnvironment(workspaceId);
}
