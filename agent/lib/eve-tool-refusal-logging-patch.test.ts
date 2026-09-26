/**
 * Eve tool-failure logging patch tests.
 *
 * Constructs covered:
 * - The installed `logToolExecutionError` skips Eve's multi-line stack for an expected coded refusal.
 * - Dependency failures, unknown exceptions and foreign errors keep Eve's native stack log.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { AppError } from "./app-error.js";
import { normalizeModelFacingError } from "./model-facing-error.js";

const TOOL_LOOP_PATH = "node_modules/eve/dist/src/harness/tool-loop.js";

type ToolExecutionEnd = {
  toolCall: { toolCallId: string; toolName: string };
  toolOutput: { error?: unknown; type: string };
};

async function installedLogger() {
  const source = await readFile(TOOL_LOOP_PATH, "utf8");
  const definition = source.match(
    /function logToolExecutionError\(e\)\{[\s\S]*?\}(?=function enrichTelemetry\()/u,
  )?.[0];
  if (!definition) throw new Error("TEST_EVE_TOOL_LOGGER_NOT_FOUND: logToolExecutionError is missing");
  const logError = vi.fn();
  // Execute the installed function, so the test proves behavior instead of a patch marker.
  const factory = new Function("logError", "log", `"use strict";${definition};return logToolExecutionError;`) as (
    logError: typeof vi.fn, log: object,
  ) => (event: ToolExecutionEnd) => void;
  return { log: factory(logError as never, {}), logError };
}

function failed(error: unknown): ToolExecutionEnd {
  return { toolCall: { toolCallId: "call-1", toolName: "web_fetch" }, toolOutput: { error, type: "tool-error" } };
}

const normalize = (error: Error) => normalizeModelFacingError(error, { toolName: "web_fetch" });

describe("Eve tool-failure logging patch", () => {
  it("does not print a stack for a coded refusal the tool boundary already recorded", async () => {
    const { log, logError } = await installedLogger();

    log(failed(normalize(new AppError("AGENT_WEB_FETCH_RESPONSE_FAILED", "HTTP 403", { isExpectedRefusal: true }))));
    log(failed(normalize(new AppError("AGENT_MEMORY_SUBJECT_REF_INVALID", "Ссылка недоступна"))));

    expect(logError).not.toHaveBeenCalled();
  });

  it.each([
    ["dependency failure", normalize(new AppError("AGENT_DATABASE_UNAVAILABLE", "База недоступна"))],
    ["unmarked operation failure", normalize(new AppError("AGENT_MEMORY_EMBEDDING_MODEL_MISMATCH", "Модель другая"))],
    ["unknown exception", normalize(new Error("connect ECONNREFUSED"))],
    ["foreign error", new Error("framework failure")],
    ["lookalike without the class", Object.assign(new Error("x"), { isExpectedRefusal: true })],
  ])("keeps Eve's stack log for a %s", async (_case, error) => {
    const { log, logError } = await installedLogger();

    log(failed(error));

    expect(logError).toHaveBeenCalledOnce();
    expect(logError.mock.calls[0]?.[1]).toBe("tool execution failed");
  });

  it("ignores successful tool results", async () => {
    const { log, logError } = await installedLogger();

    log({ toolCall: { toolCallId: "call-1", toolName: "web_fetch" }, toolOutput: { type: "tool-result" } });

    expect(logError).not.toHaveBeenCalled();
  });
});
