/**
 * Private HTTP boundary for sandbox lifecycle and execution.
 *
 * Exports:
 * - `createSandboxRunnerServer`: creates a dependency-injected internal HTTP server.
 *
 * Routes:
 * - Health, session create/stop/delete, process execution, and binary file I/O.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  parseCreateSandboxRequest,
  parseSandboxEveSessionId,
  parseSandboxProcessRequest,
  parseSandboxRemovePathRequest,
  parseSandboxSessionId,
  parseSandboxWorkspaceId,
  SANDBOX_RUNNER_API_PREFIX,
  SANDBOX_RUNNER_REQUEST_MAX_BYTES,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import type { SandboxEngine } from "./sandbox-engine.js";

interface ServerDependencies {
  engine: SandboxEngine;
}

const SESSION_ROUTE = new RegExp(`^${SANDBOX_RUNNER_API_PREFIX}/sessions/([^/]+)$`, "u");
const PROCESS_ROUTE = new RegExp(
  `^${SANDBOX_RUNNER_API_PREFIX}/sessions/([^/]+)/processes$`,
  "u",
);
const FILE_ROUTE = new RegExp(`^${SANDBOX_RUNNER_API_PREFIX}/sessions/([^/]+)/files$`, "u");
const EVE_SESSION_ROUTE = new RegExp(
  `^${SANDBOX_RUNNER_API_PREFIX}/eve-sessions/([^/]+)$`,
  "u",
);
const STOP_ROUTE = new RegExp(`^${SANDBOX_RUNNER_API_PREFIX}/sessions/([^/]+)/stop$`, "u");
const TOOL_ENVIRONMENT_ROUTE = new RegExp(
  `^${SANDBOX_RUNNER_API_PREFIX}/tool-environments/([^/]+)$`,
  "u",
);

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status);
  response.end();
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > SANDBOX_RUNNER_REQUEST_MAX_BYTES) {
      throw new Error("AGENT_SANDBOX_RUNNER_REQUEST_TOO_LARGE: Request body exceeds limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new Error("AGENT_SANDBOX_RUNNER_CONTENT_TYPE_INVALID: JSON content type is required");
  }
  const body = await readBody(request);
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch (error) {
    throw new Error("AGENT_SANDBOX_RUNNER_JSON_INVALID: Request body is not valid JSON", {
      cause: error,
    });
  }
}

function requiredPath(url: URL): string {
  const path = url.searchParams.get("path");
  if (!path) throw new Error("AGENT_SANDBOX_RUNNER_PATH_INVALID: File path is required");
  return path;
}

function requestError(error: unknown): boolean {
  return error instanceof Error && /^AGENT_SANDBOX_RUNNER_(?:CONTENT|JSON|PATH|PROCESS|REQUEST|SCOPE|SESSION)/u
    .test(error.message);
}

async function route(
  dependencies: ServerDependencies,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://sandbox-runner.internal");
  if (request.method === "GET" && url.pathname === "/health") {
    await dependencies.engine.health();
    sendJson(response, 200, { status: "ready" });
    return;
  }

  if (request.method === "POST" && url.pathname === `${SANDBOX_RUNNER_API_PREFIX}/sessions`) {
    const result = await dependencies.engine.createSession(
      parseCreateSandboxRequest(await readJson(request)),
    );
    sendJson(response, result.created ? 201 : 200, result);
    return;
  }

  const processMatch = PROCESS_ROUTE.exec(url.pathname);
  if (request.method === "POST" && processMatch) {
    const sessionId = parseSandboxSessionId(decodeURIComponent(processMatch[1]!));
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    const result = await dependencies.engine.runProcess(
      sessionId,
      parseSandboxProcessRequest(await readJson(request)),
      controller.signal,
    );
    sendJson(response, 200, result);
    return;
  }

  const fileMatch = FILE_ROUTE.exec(url.pathname);
  if (fileMatch) {
    const sessionId = parseSandboxSessionId(decodeURIComponent(fileMatch[1]!));
    const path = requiredPath(url);
    if (request.method === "GET") {
      const content = await dependencies.engine.readFile(sessionId, path);
      if (content === null) return sendEmpty(response, 404);
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(content);
      return;
    }
    if (request.method === "PUT") {
      await dependencies.engine.writeFile(sessionId, path, await readBody(request));
      sendEmpty(response, 204);
      return;
    }
    if (request.method === "DELETE") {
      await dependencies.engine.removePath(
        sessionId,
        parseSandboxRemovePathRequest({
          force: url.searchParams.get("force") === "true",
          path,
          recursive: url.searchParams.get("recursive") === "true",
        }),
      );
      sendEmpty(response, 204);
      return;
    }
  }

  const stopMatch = STOP_ROUTE.exec(url.pathname);
  if (request.method === "POST" && stopMatch) {
    await dependencies.engine.stopSession(parseSandboxSessionId(decodeURIComponent(stopMatch[1]!)));
    sendEmpty(response, 204);
    return;
  }

  const sessionMatch = SESSION_ROUTE.exec(url.pathname);
  if (request.method === "DELETE" && sessionMatch) {
    await dependencies.engine.deleteSession(
      parseSandboxSessionId(decodeURIComponent(sessionMatch[1]!)),
    );
    sendEmpty(response, 204);
    return;
  }

  const toolsMatch = TOOL_ENVIRONMENT_ROUTE.exec(url.pathname);
  if (request.method === "DELETE" && toolsMatch) {
    await dependencies.engine.deleteToolEnvironment(
      parseSandboxWorkspaceId(decodeURIComponent(toolsMatch[1]!)),
    );
    sendEmpty(response, 204);
    return;
  }

  const eveSessionMatch = EVE_SESSION_ROUTE.exec(url.pathname);
  if (request.method === "DELETE" && eveSessionMatch) {
    await dependencies.engine.deleteEveSession(
      parseSandboxEveSessionId(decodeURIComponent(eveSessionMatch[1]!)),
    );
    sendEmpty(response, 204);
    return;
  }

  sendJson(response, 404, {
    code: "AGENT_SANDBOX_RUNNER_ROUTE_NOT_FOUND",
    message: "Runner route was not found",
  });
}

export function createSandboxRunnerServer(dependencies: ServerDependencies) {
  return createServer((request, response) => {
    void route(dependencies, request, response).catch((error: unknown) => {
      const invalidRequest = requestError(error);
      console.error("Sandbox runner request failed", {
        error,
        method: request.method,
        path: request.url,
      });
      if (response.destroyed) return;
      sendJson(response, invalidRequest ? 400 : 500, {
        code: invalidRequest
          ? "AGENT_SANDBOX_RUNNER_REQUEST_INVALID"
          : "AGENT_SANDBOX_RUNNER_OPERATION_FAILED",
        message: invalidRequest
          ? "Runner request is invalid"
          : "Runner operation failed; inspect sandbox-runner logs",
      });
    });
  });
}
