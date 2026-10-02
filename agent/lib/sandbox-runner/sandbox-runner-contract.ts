/**
 * Versioned contract shared by the agent and the isolated sandbox runner.
 *
 * Exports:
 * - Runner request/response types for sessions, atomic seed bundles, processes, files, and GWS.
 * - `sandboxSeedDigest`: canonical content identity used by both agent and runner policy checks.
 * - `parseCreateSandboxRequest`: enforces the trusted/restricted scope boundary.
 * - `parseWorkspaceSandboxUseOptions`: validates mounted or explicitly disabled Eve session state.
 * - Other `parse*` helpers: validate every untrusted HTTP payload fail-closed.
 * - Runner endpoint, execution-limit, and transport-timeout constants.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { SandboxSpawnOptions } from "../../runtime/sandbox/types.js";

import { z } from "zod";

/** Authored Bash adds this requirement; native file helpers remain available without Bash. */
export interface GroupSandboxCommandOptions extends SandboxSpawnOptions {
  requiredGroupCapability?: "bash";
}

export const SANDBOX_RUNNER_API_PREFIX = "/v1";
export const SANDBOX_RUNNER_COMMAND_MAX_CHARACTERS = 100_000;
export const SANDBOX_RUNNER_ENVIRONMENT_MAX_ENTRIES = 100;
export const SANDBOX_RUNNER_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const SANDBOX_RUNNER_REQUEST_MAX_BYTES = 64 * 1024 * 1024;
export const SANDBOX_RUNNER_PROCESS_DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000;
export const SANDBOX_RUNNER_TIMEOUT_MAX_MS = 30 * 60 * 1_000;
export const SANDBOX_RUNNER_HTTP_TIMEOUT_MS = SANDBOX_RUNNER_TIMEOUT_MAX_MS + 30_000;
export const SANDBOX_RUNNER_SEED_FILES_MAX = 512;
export const SANDBOX_RUNNER_SEED_FILE_MAX_BYTES = 50 * 1024 * 1024;

const eveSessionIdSchema = z.string().regex(/^wrun_[A-Z0-9]{26}$/u);
// Eve sanitizes custom-backend keys to this alphabet and truncates them to 120 characters.
const sessionIdSchema = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);
const workspaceIdSchema = z.uuid();
const mountPointSchema = z.enum(["family", "group", "personal"]);
const workspaceMountSchema = z.strictObject({
  mountPoint: mountPointSchema,
  workspaceId: workspaceIdSchema,
});
const workspaceSandboxUseOptionsSchema = z.strictObject({
  mounts: z.array(workspaceMountSchema).max(2),
  sandboxSessionId: sessionIdSchema,
}).superRefine((options, context) => {
  const points = options.mounts.map((mount) => mount.mountPoint);
  if (new Set(points).size !== points.length) {
    context.addIssue({ code: "custom", message: "Duplicate mount point", path: ["mounts"] });
  }
});
const seedFileSchema = z.strictObject({
  contentBase64: z.base64().max(Math.ceil(SANDBOX_RUNNER_SEED_FILE_MAX_BYTES * 4 / 3) + 4),
  path: z.string().min(2).max(4_096).startsWith("/"),
});

export function sandboxSeedDigest(
  files: readonly { contentBase64: string; path: string }[],
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path).update("\0").update(file.contentBase64).update("\0");
  }
  return hash.digest("hex");
}

const createSandboxRequestSchema = z.strictObject({
  access: z.enum(["restricted", "group-tools", "trusted"]),
  eveSessionId: eveSessionIdSchema,
  mounts: z.array(workspaceMountSchema).min(1).max(2),
  sandboxSessionId: sessionIdSchema,
  seedDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  seedFiles: z.array(seedFileSchema).max(SANDBOX_RUNNER_SEED_FILES_MAX).optional(),
}).superRefine((request, context) => {
  const points = request.mounts.map((mount) => mount.mountPoint);
  if (new Set(points).size !== points.length) {
    context.addIssue({ code: "custom", message: "Duplicate mount point", path: ["mounts"] });
    return;
  }

  // Seed paths are canonical absolute paths and must never target mounted credentials.
  const seedPaths = request.seedFiles?.map((file) => file.path) ?? [];
  if (new Set(seedPaths).size !== seedPaths.length) {
    context.addIssue({ code: "custom", message: "Duplicate seed path", path: ["seedFiles"] });
  }
  for (const [index, path] of seedPaths.entries()) {
    const workspacePath = /^\/workspace\/.+/u.test(path);
    const trustedToolPath = request.access === "trusted" && /^\/tools\/(?:family|personal)\/.+/u.test(path);
    const groupToolPath = request.access === "group-tools" && /^\/tools\/group\/.+/u.test(path);
    const isolatedHomePath = request.access !== "trusted" && /^\/tmp\/home\/.+/u.test(path);
    if (
      (!workspacePath && !trustedToolPath && !groupToolPath && !isolatedHomePath) ||
      posix.normalize(path) !== path
    ) {
      context.addIssue({
        code: "custom",
        message: "Seed path is outside sandbox data roots",
        path: ["seedFiles", index, "path"],
      });
    }
  }
  if (request.seedFiles && sandboxSeedDigest(request.seedFiles) !== request.seedDigest) {
    context.addIssue({ code: "custom", message: "Seed digest mismatch", path: ["seedDigest"] });
  }

  // Restricted sessions are external groups and may receive only their isolated group workspace.
  if (request.access !== "trusted") {
    if (points.length !== 1 || points[0] !== "group") {
      context.addIssue({ code: "custom", message: "Restricted scope mismatch", path: ["mounts"] });
    }
    return;
  }

  // Trusted sessions must never smuggle an external group volume into a network-enabled sandbox.
  if (points.includes("group")) {
    context.addIssue({ code: "custom", message: "Trusted scope mismatch", path: ["mounts"] });
  }
});

const environmentSchema = z.record(
  z.string().min(1).max(256),
  z.string().max(32_768),
).superRefine((environment, context) => {
  if (Object.keys(environment).length > SANDBOX_RUNNER_ENVIRONMENT_MAX_ENTRIES) {
    context.addIssue({ code: "custom", message: "Too many environment entries" });
  }
});

const processRequestSchema = z.strictObject({
  command: z.string().min(1).max(SANDBOX_RUNNER_COMMAND_MAX_CHARACTERS),
  expectedInstanceId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  environment: environmentSchema.optional(),
  timeoutMs: z.number().int().positive().max(SANDBOX_RUNNER_TIMEOUT_MAX_MS).optional(),
  workingDirectory: z.string().min(1).max(4_096).optional(),
});

const googleWorkspaceExecutionRequestSchema = z.strictObject({
  accessToken: z.string().min(1).max(16 * 1024),
  argv: z.array(z.string().min(1).max(64 * 1024)).min(1).max(128),
  timeoutMs: z.number().int().positive().max(SANDBOX_RUNNER_TIMEOUT_MAX_MS),
  workspaceId: workspaceIdSchema,
});

const removePathRequestSchema = z.strictObject({
  force: z.boolean().optional(),
  path: z.string().min(1).max(4_096),
  recursive: z.boolean().optional(),
});

export type SandboxAccess = "restricted" | "group-tools" | "trusted";
export type GoogleWorkspaceExecutionRequest = z.infer<typeof googleWorkspaceExecutionRequestSchema>;
export type SandboxMountPoint = z.infer<typeof mountPointSchema>;
export type SandboxRunnerCreateRequest = z.infer<typeof createSandboxRequestSchema>;
export type SandboxRunnerMount = z.infer<typeof workspaceMountSchema>;
export type SandboxRunnerProcessRequest = z.infer<typeof processRequestSchema>;
export type SandboxRunnerRemovePathRequest = z.infer<typeof removePathRequestSchema>;
export type SandboxRunnerSeedFile = z.infer<typeof seedFileSchema>;

export interface WorkspaceSandboxMount {
  mountPoint: SandboxMountPoint;
  workspaceId: string;
}

export interface WorkspaceSandboxUseOptions {
  mounts: WorkspaceSandboxMount[];
  sandboxSessionId: string;
}

export interface SandboxRunnerProcessResponse {
  exitCode: number;
  processId: string;
  stderr: string;
  stdout: string;
}

export interface SandboxRunnerSessionResponse {
  created: boolean;
  seedRequired: boolean;
  sessionId: string;
  instanceId?: string;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`${code}: ${z.prettifyError(parsed.error)}`);
}

export function parseCreateSandboxRequest(value: unknown): SandboxRunnerCreateRequest {
  return parseOrThrow(createSandboxRequestSchema, value, "AGENT_SANDBOX_RUNNER_SCOPE_INVALID");
}

export function parseWorkspaceSandboxUseOptions(value: unknown): WorkspaceSandboxUseOptions {
  return parseOrThrow(
    workspaceSandboxUseOptionsSchema,
    value,
    "AGENT_SANDBOX_RUNNER_SESSION_OPTIONS_INVALID",
  );
}

export function parseGoogleWorkspaceExecutionRequest(
  value: unknown,
): GoogleWorkspaceExecutionRequest {
  return parseOrThrow(
    googleWorkspaceExecutionRequestSchema,
    value,
    "AGENT_SANDBOX_RUNNER_GOOGLE_WORKSPACE_REQUEST_INVALID",
  );
}

export function parseSandboxProcessRequest(value: unknown): SandboxRunnerProcessRequest {
  return parseOrThrow(processRequestSchema, value, "AGENT_SANDBOX_RUNNER_PROCESS_INVALID");
}

export function parseSandboxRemovePathRequest(value: unknown): SandboxRunnerRemovePathRequest {
  return parseOrThrow(removePathRequestSchema, value, "AGENT_SANDBOX_RUNNER_PATH_INVALID");
}

export function parseSandboxSessionId(value: unknown): string {
  return parseOrThrow(sessionIdSchema, value, "AGENT_SANDBOX_RUNNER_SESSION_ID_INVALID");
}

export function parseSandboxEveSessionId(value: unknown): string {
  return parseOrThrow(eveSessionIdSchema, value, "AGENT_SANDBOX_RUNNER_EVE_SESSION_ID_INVALID");
}

export function parseSandboxWorkspaceId(value: unknown): string {
  return parseOrThrow(workspaceIdSchema, value, "AGENT_SANDBOX_RUNNER_WORKSPACE_ID_INVALID");
}
