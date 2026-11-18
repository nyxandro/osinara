/**
 * Running a step's tool calls.
 *
 * Constructs covered:
 * - A call whose write may have reached the database before the connection broke (`ROLLBACK` failed after
 *   `COMMIT` was sent) ends as `unknown`, with the text that tells the model to check before repeating (#539);
 *   an ordinary failure is a completed call with its error text, as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AppError } from "../../lib/app-error.js";
import { memoryToolState } from "../session/tool-state.test-fixtures.js";
import { defineTool, type ToolContext, type ToolDefinition } from "../tool.js";
import { executeStepCalls, STORAGE_OUTCOME_UNKNOWN_OUTPUT } from "./step-calls.js";
import type { ToolCallRecord } from "./turn-types.js";

const CONTEXT = {
  abortSignal: new AbortController().signal,
  callId: "call-1",
  getSandbox: async () => { throw new Error("TEST_SANDBOX_UNUSED"); },
  loadSkill: async () => { throw new Error("TEST_SKILL_UNUSED"); },
  session: { auth: { current: null, initiator: null }, id: "wrun_01M3YNFXVX5WCP17ZVB8ZTMQAR", turn: { id: "turn_01M3YNFXVX5WCP17ZVB8ZTMQAS", sequence: 0 } },
  skills: [],
  state: memoryToolState().state,
  toolName: "remember",
} satisfies ToolContext;

const CALL: ToolCallRecord = {
  callId: "call-1", input: {}, inputRequest: null, inputResponse: null, output: null, position: 0, state: "planned", stepIndex: 0, toolName: "remember",
};

function tool(execute: ToolDefinition<Record<string, never>, unknown>["execute"]) {
  return defineTool({ description: "remember", inputSchema: z.object({}), execute } as ToolDefinition);
}

function journal() {
  return { markIntent: vi.fn(async () => undefined), park: vi.fn(async () => undefined), settle: vi.fn(async () => undefined) };
}

async function run(execute: ToolDefinition<Record<string, never>, unknown>["execute"]) {
  const calls = journal();
  const [result] = await executeStepCalls({
    calls: [CALL], contextFor: () => CONTEXT, delegateCall: vi.fn(), journal: calls, tools: { remember: tool(execute) },
  });
  return { calls, result: result! };
}

afterEach(() => vi.restoreAllMocks());

describe("step calls", () => {
  it("ends a call as unknown when the connection broke after its write may have been committed (#539)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const commitLost = new Error("Connection terminated unexpectedly");
    const rollbackFailed = new AggregateError([commitLost, new Error("Client has encountered a connection error")], "AGENT_DATABASE_ROLLBACK_FAILED", { cause: commitLost });
    // Tools wrap storage errors in their own; the outcome is unknown wherever it sits in the chain.
    for (const thrown of [rollbackFailed, new AppError("AGENT_MEMORY_WRITE_FAILED", "Не удалось сохранить", { cause: rollbackFailed })]) {
      const { calls, result } = await run(async () => { throw thrown; });
      expect(result).toMatchObject({ output: STORAGE_OUTCOME_UNKNOWN_OUTPUT, state: "unknown" });
      expect(calls.settle).toHaveBeenCalledWith("call-1", "unknown", STORAGE_OUTCOME_UNKNOWN_OUTPUT);
    }
  });

  it("keeps an ordinary failure a completed call with its error text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { calls, result } = await run(async () => { throw new AppError("AGENT_PROBE_FAILED", "Не получилось"); });
    expect(result).toMatchObject({ output: { type: "error-text", value: "AppError: AGENT_PROBE_FAILED: Не получилось" }, state: "completed" });
    expect(calls.settle).toHaveBeenCalledWith("call-1", "completed", expect.anything());
  });
});
