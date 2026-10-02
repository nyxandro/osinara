/**
 * The tool calls of one model step: their first journal state, and their execution.
 *
 * Exports:
 * - `planStepCalls`: each call of a fresh model response becomes a journal record — a result
 *   already known (broken input, unknown tool, policy denial), a request for a person, or a plan
 *   to run it.
 * - `executeStepCalls`: runs the planned calls concurrently, writing the intent before each one;
 *   after a crash it reruns an interrupted call only when the tool is replay-safe, and a call whose
 *   tool is no longer granted does not run.
 * - `UNKNOWN_OUTCOME_OUTPUT`: what the model reads about a call whose outcome is unknown.
 *
 * Derived from eve 0.40.0 `harness/tool-loop.ts` (`handleStepResult`: invalid-input results,
 * approval and question extraction) and AI SDK 7.0.60 `streamText` tool execution (Apache-2.0,
 * see NOTICE-eve). Changes: the runtime runs the tools after the model call and journals every
 * transition, so a restart neither repeats a finished call nor guesses about an interrupted one.
 */
import type { ModelMessage } from "ai";

import { approvalRequest, ASK_QUESTION_TOOL_NAME, deniedOutput, questionRequest } from "../hitl/input-requests.js";
import type { ToolContext, ToolDefinition } from "../tool.js";
import type { StepToolCall } from "./model-call.js";
import { decideToolApproval, executeToolCall, resolveToolCallInput, type ToolResultOutput } from "./tool-calls.js";
import type { ToolCallRecord } from "./turn-types.js";

export type PlannedCall = Omit<ToolCallRecord, "stepIndex">;
type AnyToolDefinition = ToolDefinition<any, any>;

export const UNKNOWN_OUTCOME_OUTPUT: ToolResultOutput = {
  type: "error-text",
  value: "AGENT_TOOL_OUTCOME_UNKNOWN: This tool call was interrupted by a restart and may or may not have taken effect. It was not repeated. Check the actual state before trying again, and tell the user if it matters.",
};

function unavailableOutput(toolName: string): ToolResultOutput {
  return {
    type: "error-text",
    value: `AGENT_TOOL_UNAVAILABLE: The tool "${toolName}" is no longer available in this conversation, so the call did not run.`,
  };
}

// Results AI SDK already produced inside the response: an unknown tool or an input that failed its schema.
function synthesizedOutputs(response: readonly ModelMessage[]): Map<string, ToolResultOutput> {
  const outputs = new Map<string, ToolResultOutput>();
  for (const message of response) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") outputs.set(part.toolCallId, part.output);
    }
  }
  return outputs;
}

export async function planStepCalls(input: {
  readonly contextFor: (call: { readonly callId: string; readonly toolName: string }) => ToolContext;
  readonly response: readonly ModelMessage[];
  readonly toolCalls: readonly StepToolCall[];
  readonly tools: Readonly<Record<string, AnyToolDefinition>>;
}): Promise<PlannedCall[]> {
  const synthesized = synthesizedOutputs(input.response);
  const planned: PlannedCall[] = [];
  for (const [position, call] of input.toolCalls.entries()) {
    const base = { callId: call.toolCallId, inputRequest: null, inputResponse: null, position, toolName: call.toolName };
    const known = synthesized.get(call.toolCallId);
    if (known !== undefined) {
      planned.push({ ...base, input: {}, output: known, state: "completed" });
      continue;
    }
    const parsed = resolveToolCallInput(call);
    if ("error" in parsed) {
      planned.push({ ...base, input: {}, output: { type: "error-text", value: parsed.error }, state: "completed" });
      continue;
    }
    const definition = input.tools[call.toolName];
    if (definition === undefined) {
      throw new Error(`AGENT_TURN_TOOL_MISSING: tool "${call.toolName}" of call ${call.toolCallId} is not in the step's tool set`);
    }
    const parked = { callId: call.toolCallId, input: parsed.input, toolName: call.toolName };
    if (call.toolName === ASK_QUESTION_TOOL_NAME) {
      planned.push({ ...base, input: parsed.input, inputRequest: questionRequest(parked), output: null, state: "awaiting_input" });
      continue;
    }
    const decision = await decideToolApproval(definition, parsed.input, input.contextFor(base));
    if (decision.kind === "ask") {
      planned.push({ ...base, input: parsed.input, inputRequest: approvalRequest(parked), output: null, state: "awaiting_input" });
    } else if (decision.kind === "deny") {
      planned.push({ ...base, input: parsed.input, output: deniedOutput(decision.reason), state: "completed" });
    } else {
      planned.push({ ...base, input: parsed.input, output: null, state: "planned" });
    }
  }
  return planned;
}

export interface CallJournal {
  markIntent(callId: string): Promise<void>;
  settle(callId: string, state: "completed" | "unknown", output: ToolResultOutput): Promise<void>;
}

/** Returns every call of the step with its state after this run. */
export async function executeStepCalls(input: {
  readonly calls: readonly ToolCallRecord[];
  readonly contextFor: (call: { readonly callId: string; readonly toolName: string }) => ToolContext;
  readonly journal: CallJournal;
  readonly tools: Readonly<Record<string, AnyToolDefinition>>;
}): Promise<ToolCallRecord[]> {
  const settled = await Promise.allSettled(input.calls.map(async (call): Promise<ToolCallRecord> => {
    if (call.state !== "planned" && call.state !== "intent") return call;
    const definition = input.tools[call.toolName];
    if (call.state === "intent" && definition?.replaySafe !== true) {
      await input.journal.settle(call.callId, "unknown", UNKNOWN_OUTCOME_OUTPUT);
      return { ...call, output: UNKNOWN_OUTCOME_OUTPUT, state: "unknown" };
    }
    if (definition === undefined) {
      // A continuation runs with the tools granted now; a revoked tool must not run on an old approval.
      const output = unavailableOutput(call.toolName);
      await input.journal.settle(call.callId, "completed", output);
      return { ...call, output, state: "completed" };
    }
    if (call.state === "planned") await input.journal.markIntent(call.callId);
    const output = await executeToolCall(definition, call.input, input.contextFor(call));
    await input.journal.settle(call.callId, "completed", output);
    return { ...call, output, state: "completed" };
  }));
  const failure = settled.find((result) => result.status === "rejected");
  if (failure !== undefined) throw (failure as PromiseRejectedResult).reason;
  return settled.map((result) => (result as PromiseFulfilledResult<ToolCallRecord>).value);
}
