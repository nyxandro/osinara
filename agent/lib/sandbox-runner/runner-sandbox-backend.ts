/**
 * Eve backend for the isolated Osinara sandbox runner.
 *
 * Exports:
 * - `scopedWorkspaceRunner`: real-Bash backend with trusted scoped tools persistence.
 * - `deleteRunnerSandboxSession`: removes retained sandbox compute without deleting tools.
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
  WorkspaceSandboxMount,
  WorkspaceSandboxUseOptions,
} from "./sandbox-runner-contract.js";
import { parseSandboxEveSessionId } from "./sandbox-runner-contract.js";
import { SandboxRunnerClient } from "./runner-client.js";

const BACKEND_NAME = "osinara-scoped-runner";
const CACHE_DIRECTORY = "osinara-scoped-runner";
const TEMPLATE_SCHEMA_VERSION = 1;

interface BackendOptions {
  baseUrl?: string;
}

interface StoredTemplate {
  files: Array<{ contentBase64: string; path: string }>;
  version: number;
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
  id: string;
}): SandboxSession {
  async function spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
    const controller = new AbortController();
    let killed = false;
    const completion = input.client.run(input.id, {
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
        await input.client.stop(input.id);
      },
      async wait() {
        return { exitCode: (await completion).exitCode };
      },
    };
  }

  async function readBytes(path: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    return await input.client.readFile(input.id, resolveSandboxPath(path), signal);
  }

  async function writeBytes(path: string, content: Uint8Array, signal?: AbortSignal): Promise<void> {
    await input.client.writeFile(input.id, resolveSandboxPath(path), content, signal);
  }

  return {
    id: input.id,
    resolvePath: resolveSandboxPath,
    async run(options) {
      const result = await input.client.run(input.id, {
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
      await input.client.removePath(input.id, {
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
      if (input.existingMetadata && input.existingMetadata.version !== TEMPLATE_SCHEMA_VERSION) {
        throw new Error("AGENT_SANDBOX_RUNNER_STATE_INVALID: Reconnect schema mismatch");
      }
      const template = input.templateKey === null
        ? null
        : await loadTemplate(input.runtimeContext.appRoot, input.templateKey);
      // The backend key identifies one sandbox; the framework tag identifies its durable Eve session.
      const eveSessionId = parseSandboxEveSessionId(input.tags?.sessionId);
      let mounts: WorkspaceSandboxMount[] | null = null;
      let access: SandboxAccess | null = null;
      const session = buildSession({ access: () => access, client, id: input.sessionKey });
      return {
        session,
        async useSessionFn(useOptions) {
          if (!useOptions) throw new Error("AGENT_SANDBOX_RUNNER_MOUNTS_MISSING: Mounts are required");
          if (mounts) {
            if (JSON.stringify(mounts) !== JSON.stringify(useOptions.mounts)) {
              throw new Error("AGENT_SANDBOX_RUNNER_REMOUNT_DENIED: Session mounts are immutable");
            }
            return session;
          }
          access = accessForMounts(useOptions.mounts);
          const created = await client.create({
            access,
            eveSessionId,
            mounts: useOptions.mounts,
            sessionId: input.sessionKey,
          });
          mounts = structuredClone(useOptions.mounts);
          if (created.created) {
            for (const file of template?.files ?? []) {
              await client.writeFile(
                input.sessionKey,
                resolveSeedPath(file.path, access, mounts),
                Buffer.from(file.contentBase64, "base64"),
              );
            }
          }
          return session;
        },
        async captureState() {
          return {
            backendName: BACKEND_NAME,
            metadata: { version: TEMPLATE_SCHEMA_VERSION },
            sessionKey: input.sessionKey,
          };
        },
        async shutdown() {
          if (mounts) await client.stop(input.sessionKey);
        },
      };
    },
  };
}

export async function deleteRunnerSandboxSession(
  eveSessionId: string,
  baseUrl = SANDBOX_RUNNER_BASE_URL,
): Promise<void> {
  await new SandboxRunnerClient(baseUrl).deleteEveSession(eveSessionId);
}

export async function deleteRunnerToolEnvironment(
  workspaceId: string,
  baseUrl = SANDBOX_RUNNER_BASE_URL,
): Promise<void> {
  await new SandboxRunnerClient(baseUrl).deleteToolEnvironment(workspaceId);
}
