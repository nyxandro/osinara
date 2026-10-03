import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AppError } from "../../lib/app-error.js";
import { memoryToolState } from "../session/tool-state.test-fixtures.js";
import { defineTool, type ToolContext, type ToolDefinition } from "../tool.js";
import { decideToolApproval, executeToolCall, resolveToolCallInput } from "./tool-calls.js";

const CONTEXT = {
  abortSignal: new AbortController().signal,
  callId: "call-1",
  getSandbox: async () => { throw new Error("TEST_SANDBOX_UNUSED"); },
  session: { auth: { current: null, initiator: null }, id: "wrun_01M3YNFXVX5WCP17ZVB8ZTMQAR", turn: { id: "turn_01M3YNFXVX5WCP17ZVB8ZTMQAS", sequence: 0 } },
  skills: [],
  state: memoryToolState().state,
  toolName: "probe",
} satisfies ToolContext;

function probe(execute: ToolDefinition<{ value?: string }, unknown>["execute"], extra: Partial<ToolDefinition> = {}) {
  return defineTool({ description: "probe", inputSchema: z.object({ value: z.string().optional() }), execute, ...extra } as ToolDefinition);
}

afterEach(() => vi.restoreAllMocks());

describe("tool call execution", () => {
  it("shows a string result as text and anything else as JSON, an empty result as null", async () => {
    expect(await executeToolCall(probe(() => "готово"), { value: "x" }, CONTEXT)).toEqual({ type: "text", value: "готово" });
    expect(await executeToolCall(probe(async () => ({ b: 1, a: [true] })), {}, CONTEXT)).toEqual({ type: "json", value: { b: 1, a: [true] } });
    expect(await executeToolCall(probe(async () => undefined), {}, CONTEXT)).toEqual({ type: "json", value: null });
  });

  it("passes the input and the call context to the tool", async () => {
    const execute = vi.fn(async () => "ok");

    await executeToolCall(probe(execute), { value: "вход" }, CONTEXT);

    expect(execute).toHaveBeenCalledWith({ value: "вход" }, CONTEXT);
  });

  it("uses the tool's own model projection", async () => {
    const tool = probe(async () => ({ secret: "s", visible: "v" }), {
      toModelOutput: (output: unknown) => ({ type: "json", value: { visible: (output as { visible: string }).visible } }),
    });

    expect(await executeToolCall(tool, {}, CONTEXT)).toEqual({ type: "json", value: { visible: "v" } });
  });

  it("turns a failure into the error text the model reads, logged as one line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const output = await executeToolCall(probe(async () => { throw new AppError("AGENT_PROBE_FAILED", "Не получилось"); }), {}, CONTEXT);

    expect(output).toEqual({ type: "error-text", value: "AppError: AGENT_PROBE_FAILED: Не получилось" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      code: "AGENT_TOOL_EXECUTION_FAILED", errorCode: "AGENT_PROBE_FAILED", toolCallId: "call-1", toolName: "probe",
    });
  });

  it("does not log an expected coded refusal a second time", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = Object.assign(new Error("AGENT_SITE_REFUSED: сайт отказал"), { name: "ModelFacingError", isExpectedRefusal: true });

    expect(await executeToolCall(probe(async () => { throw refusal; }), {}, CONTEXT))
      .toEqual({ type: "error-text", value: "ModelFacingError: AGENT_SITE_REFUSED: сайт отказал" });
    expect(log).not.toHaveBeenCalled();
  });

  it("reports a result the model could not read instead of sending it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const output = await executeToolCall(probe(async () => ({ at: new Date(0) })), {}, CONTEXT);

    expect(output.type).toBe("error-text");
  });

  it("lets a cancellation stop the turn instead of becoming a tool result", async () => {
    const turn = new AbortController();
    turn.abort(new Error("cancelled"));

    await expect(executeToolCall(probe(async () => { throw new Error("aborted"); }), {}, { ...CONTEXT, abortSignal: turn.signal }))
      .rejects.toMatchObject({ name: "TurnCancelledError" });
  });
});

describe("tool approval decision", () => {
  const withApproval = (approval: ToolDefinition["approval"]) => probe(async () => "ok", { approval });

  it.each([
    [undefined, { kind: "execute" }],
    [() => undefined, { kind: "execute" }],
    [() => false, { kind: "execute" }],
    [() => "not-applicable" as const, { kind: "execute" }],
    [() => "approved" as const, { kind: "execute" }],
    [() => ({ type: "approved" as const }), { kind: "execute" }],
    [() => true, { kind: "ask" }],
    [() => "user-approval" as const, { kind: "ask" }],
    [async () => ({ type: "user-approval" as const }), { kind: "ask" }],
    [() => "denied" as const, { kind: "deny", reason: undefined }],
    [() => ({ type: "denied" as const, reason: "Не сегодня" }), { kind: "deny", reason: "Не сегодня" }],
  ])("maps the policy answer %# to the runtime decision", async (approval, decision) => {
    expect(await decideToolApproval(withApproval(approval as ToolDefinition["approval"]), { value: "x" }, CONTEXT)).toEqual(decision);
  });

  it("shows the policy the call input and identity", async () => {
    const approval = vi.fn(() => "not-applicable" as const);

    await decideToolApproval(withApproval(approval), { value: "x" }, CONTEXT);

    expect(approval).toHaveBeenCalledWith(expect.objectContaining({
      approvedTools: new Set(), callId: "call-1", session: CONTEXT.session, toolInput: { value: "x" }, toolName: "probe",
    }));
  });
});

describe("tool call input", () => {
  it.each([[undefined, {}], [null, {}], ["", {}], ['{"a":1}', { a: 1 }], [{ a: 1 }, { a: 1 }]])("accepts %j as an object", (input, expected) => {
    expect(resolveToolCallInput({ input, toolCallId: "c", toolName: "t" })).toEqual({ input: expected });
  });

  it("reports an input that is not an object with the reference wording", () => {
    expect(resolveToolCallInput({ input: [1], toolCallId: "c", toolName: "t" })).toEqual({
      error: 'Failed to parse tool-call arguments for "t" (c): Expected a JSON-serializable object.',
    });
  });
});
