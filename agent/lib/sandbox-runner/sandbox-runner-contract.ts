/**
 * Versioned contract shared by the agent and the isolated sandbox runner.
 *
 * Exports:
 * - Runner request/response types for sessions, processes, and file operations.
 * - `parseCreateSandboxRequest`: enforces the trusted/restricted scope boundary.
 * - Other `parse*` helpers: validate every untrusted HTTP payload fail-closed.
 * - Runner endpoint and execution-limit constants.
 */
import { z } from "zod";

export const SANDBOX_RUNNER_API_PREFIX = "/v1";
export const SANDBOX_RUNNER_COMMAND_MAX_CHARACTERS = 100_000;
export const SANDBOX_RUNNER_ENVIRONMENT_MAX_ENTRIES = 100;
export const SANDBOX_RUNNER_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const SANDBOX_RUNNER_REQUEST_MAX_BYTES = 64 * 1024 * 1024;
export const SANDBOX_RUNNER_TIMEOUT_MAX_MS = 30 * 60 * 1_000;

const eveSessionIdSchema = z.string().regex(/^wrun_[A-Z0-9]{26}$/u);
// Eve sanitizes custom-backend keys to this alphabet and truncates them to 120 characters.
const sessionIdSchema = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);
const workspaceIdSchema = z.uuid();
const mountPointSchema = z.enum(["family", "group", "personal"]);
const workspaceMountSchema = z.strictObject({
  mountPoint: mountPointSchema,
  workspaceId: workspaceIdSchema,
});

const createSandboxRequestSchema = z.strictObject({
  access: z.enum(["restricted", "trusted"]),
  eveSessionId: eveSessionIdSchema,
  mounts: z.array(workspaceMountSchema).min(1).max(2),
  sandboxSessionId: workspaceIdSchema,
}).superRefine((request, context) => {
  const points = request.mounts.map((mount) => mount.mountPoint);
  if (new Set(points).size !== points.length) {
    context.addIssue({ code: "custom", message: "Duplicate mount point", path: ["mounts"] });
    return;
  }

  // Restricted sessions are external groups and may receive only their isolated group workspace.
  if (request.access === "restricted") {
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
  environment: environmentSchema.optional(),
  timeoutMs: z.number().int().positive().max(SANDBOX_RUNNER_TIMEOUT_MAX_MS).optional(),
  workingDirectory: z.string().min(1).max(4_096).optional(),
});

const removePathRequestSchema = z.strictObject({
  force: z.boolean().optional(),
  path: z.string().min(1).max(4_096),
  recursive: z.boolean().optional(),
});

export type SandboxAccess = "restricted" | "trusted";
export type SandboxMountPoint = z.infer<typeof mountPointSchema>;
export type SandboxRunnerCreateRequest = z.infer<typeof createSandboxRequestSchema>;
export type SandboxRunnerMount = z.infer<typeof workspaceMountSchema>;
export type SandboxRunnerProcessRequest = z.infer<typeof processRequestSchema>;
export type SandboxRunnerRemovePathRequest = z.infer<typeof removePathRequestSchema>;

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
  sessionId: string;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`${code}: ${z.prettifyError(parsed.error)}`);
}

export function parseCreateSandboxRequest(value: unknown): SandboxRunnerCreateRequest {
  return parseOrThrow(createSandboxRequestSchema, value, "AGENT_SANDBOX_RUNNER_SCOPE_INVALID");
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
