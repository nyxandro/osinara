/**
 * Typed HTTP client for the internal sandbox runner.
 *
 * Export:
 * - `SandboxRunnerClient`: session, file, process, and isolated GWS operations.
 */
import { Agent, fetch } from "undici";
import type { SkillSyncRequest, SkillSyncResult } from "./skill-sync-contract.js";

import type {
  GoogleWorkspaceExecutionRequest,
  SandboxRunnerCreateRequest,
  SandboxRunnerProcessRequest,
  SandboxRunnerProcessResponse,
  SandboxRunnerRemovePathRequest,
  SandboxRunnerSessionResponse,
} from "./sandbox-runner-contract.js";
import {
  SANDBOX_RUNNER_API_PREFIX,
  SANDBOX_RUNNER_HTTP_TIMEOUT_MS,
} from "./sandbox-runner-contract.js";

type RunnerResponse = Awaited<ReturnType<typeof fetch>>;

// Process responses intentionally send no headers until execution completes.
const runnerDispatcher = new Agent({
  bodyTimeout: SANDBOX_RUNNER_HTTP_TIMEOUT_MS,
  headersTimeout: SANDBOX_RUNNER_HTTP_TIMEOUT_MS,
});

interface RunnerErrorBody {
  code?: unknown;
  message?: unknown;
}

async function runnerError(response: RunnerResponse): Promise<Error> {
  let body: RunnerErrorBody = {};
  try {
    body = await response.json() as RunnerErrorBody;
  } catch {
    // The runner status still provides actionable context when an intermediary returned non-JSON.
  }
  const code = typeof body.code === "string" ? body.code : "AGENT_SANDBOX_RUNNER_HTTP_FAILED";
  const message = typeof body.message === "string" ? body.message : "Runner request failed";
  return new Error(`${code}: ${message} (HTTP ${response.status})`);
}

async function requireSuccess(response: RunnerResponse): Promise<RunnerResponse> {
  if (response.ok) return response;
  throw await runnerError(response);
}

function validateProcessResponse(value: unknown): SandboxRunnerProcessResponse {
  const response = value as Partial<SandboxRunnerProcessResponse>;
  if (
    typeof response.exitCode !== "number" ||
    typeof response.processId !== "string" ||
    typeof response.stderr !== "string" ||
    typeof response.stdout !== "string"
  ) {
    throw new Error("AGENT_SANDBOX_RUNNER_RESPONSE_INVALID: Process response is malformed");
  }
  return response as SandboxRunnerProcessResponse;
}

export class SandboxRunnerClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    const parsed = new URL(baseUrl);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/") {
      throw new Error("AGENT_SANDBOX_RUNNER_BASE_URL_INVALID: Runner base URL is invalid");
    }
    this.#baseUrl = parsed.toString().replace(/\/$/u, "");
  }

  #sessionUrl(sessionId: string, suffix = ""): string {
    return `${this.#baseUrl}${SANDBOX_RUNNER_API_PREFIX}/sessions/${encodeURIComponent(sessionId)}${suffix}`;
  }

  async create(request: SandboxRunnerCreateRequest): Promise<SandboxRunnerSessionResponse> {
    const response = await requireSuccess(await fetch(
      `${this.#baseUrl}${SANDBOX_RUNNER_API_PREFIX}/sessions`,
      {
        body: JSON.stringify(request),
        dispatcher: runnerDispatcher,
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ));
    const body = await response.json() as Partial<SandboxRunnerSessionResponse>;
    if (
      typeof body.created !== "boolean" ||
      typeof body.seedRequired !== "boolean" ||
      (!body.seedRequired && (typeof body.instanceId !== "string" || !/^[a-f0-9]{64}$/u.test(body.instanceId))) ||
      body.sessionId !== request.sandboxSessionId
    ) {
      throw new Error("AGENT_SANDBOX_RUNNER_RESPONSE_INVALID: Session response is malformed");
    }
    return body as SandboxRunnerSessionResponse;
  }

  async run(
    sessionId: string,
    request: SandboxRunnerProcessRequest,
    signal?: AbortSignal,
  ): Promise<SandboxRunnerProcessResponse> {
    const response = await requireSuccess(await fetch(this.#sessionUrl(sessionId, "/processes"), {
      body: JSON.stringify(request),
      dispatcher: runnerDispatcher,
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    }));
    return validateProcessResponse(await response.json());
  }

  async syncSkills(sessionId: string, request: SkillSyncRequest): Promise<SkillSyncResult> {
    const response = await requireSuccess(await fetch(this.#sessionUrl(sessionId, "/skills"), {
      method: "POST", dispatcher: runnerDispatcher, headers: { "content-type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(70_000),
    }));
    const result = await response.json() as SkillSyncResult;
    if (!result || ![result.checked, result.written, result.removed].every((value) => Number.isSafeInteger(value) && value >= 0) ||
        result.checked !== request.packages.reduce((count, pkg) => count + pkg.files.length, 0) ||
        result.written > result.checked) {
      throw new Error("AGENT_SANDBOX_RUNNER_SKILLS_RESPONSE_INVALID: Incomplete skill synchronization result");
    }
    return result;
  }

  async runGoogleWorkspace(
    request: GoogleWorkspaceExecutionRequest,
    signal?: AbortSignal,
  ): Promise<SandboxRunnerProcessResponse> {
    const response = await requireSuccess(await fetch(
      `${this.#baseUrl}${SANDBOX_RUNNER_API_PREFIX}/google-workspace/executions`,
      {
        body: JSON.stringify(request),
        dispatcher: runnerDispatcher,
        headers: { "content-type": "application/json" },
        method: "POST",
        signal,
      },
    ));
    return validateProcessResponse(await response.json());
  }

  async readFile(sessionId: string, path: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    const url = `${this.#sessionUrl(sessionId, "/files")}?path=${encodeURIComponent(path)}`;
    const response = await fetch(url, { dispatcher: runnerDispatcher, signal });
    if (response.status === 404) {
      // Undici requires every body to be consumed or cancelled before its pooled connection is reusable.
      await response.body?.cancel();
      return null;
    }
    await requireSuccess(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(
    sessionId: string,
    path: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.#sessionUrl(sessionId, "/files")}?path=${encodeURIComponent(path)}`;
    await requireSuccess(await fetch(url, {
      body: Buffer.from(content),
      dispatcher: runnerDispatcher,
      headers: { "content-type": "application/octet-stream" },
      method: "PUT",
      signal,
    }));
  }

  async removePath(
    sessionId: string,
    request: SandboxRunnerRemovePathRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const search = new URLSearchParams({ path: request.path });
    if (request.force !== undefined) search.set("force", String(request.force));
    if (request.recursive !== undefined) search.set("recursive", String(request.recursive));
    await requireSuccess(await fetch(`${this.#sessionUrl(sessionId, "/files")}?${search}`, {
      dispatcher: runnerDispatcher,
      method: "DELETE",
      signal,
    }));
  }

  async stop(sessionId: string): Promise<void> {
    await requireSuccess(await fetch(this.#sessionUrl(sessionId, "/stop"), {
      dispatcher: runnerDispatcher,
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    }));
  }

  async deleteToolEnvironment(workspaceId: string): Promise<void> {
    const url = `${this.#baseUrl}${SANDBOX_RUNNER_API_PREFIX}/tool-environments/${encodeURIComponent(workspaceId)}`;
    await requireSuccess(await fetch(url, { dispatcher: runnerDispatcher, method: "DELETE" }));
  }
}
