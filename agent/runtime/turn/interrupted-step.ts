/**
 * What a failed or cancelled turn had already done, kept in the session history (#561).
 *
 * Export:
 * - `interruptedStepMessages`: the history messages of the step the turn left open when any of its
 *   calls started, preceded by the turn input when the turn had not written history yet.
 *
 * A step goes into history only once all its calls settle. Before this, a reminder created by a call of
 * a step that never finished was missing from history, and the next turn, asked again, created another.
 * Every call of the step gets a result, as the provider pairs results with calls: a call that settled
 * keeps its own, one that started and was cut off reads as of unknown outcome, one that never started
 * reads as not run. Nothing is repeated.
 */
import type { ModelMessage } from "ai";

import { turnInputMessages } from "../prompt/turn-instructions.js";
import { loadStep, type JournalClient } from "./journal-repository.js";
import { stepHistoryMessages } from "./step-history.js";
import type { ToolResultOutput } from "./tool-calls.js";
import type { ToolCallRecord, TurnRecord } from "./turn-types.js";

const CUT_OFF_OUTPUT: ToolResultOutput = {
  type: "error-text",
  value: "AGENT_TOOL_OUTCOME_UNKNOWN: The turn ended while this call was running; it may or may not have taken effect. It was not repeated. Check the actual state before trying again, and tell the user if it matters.",
};
const NOT_RUN_OUTPUT: ToolResultOutput = {
  type: "error-text",
  value: "AGENT_TOOL_NOT_RUN: The turn ended before this call ran. It had no effect.",
};

function outputOf(call: ToolCallRecord): ToolResultOutput {
  if ((call.state === "completed" || call.state === "unknown") && call.output !== null) return call.output;
  if (call.state === "intent") return CUT_OFF_OUTPUT;
  return NOT_RUN_OUTPUT;
}

function started(call: ToolCallRecord): boolean {
  return call.state === "completed" || call.state === "unknown" || call.state === "intent";
}

/** `turn` must be read in the same transaction that appends the result, so its step index is current. */
export async function interruptedStepMessages(client: JournalClient, turn: TurnRecord): Promise<ModelMessage[]> {
  const open = await loadStep(client, turn.id, turn.nextStepIndex);
  if (open === null || open.step.completed || !open.calls.some(started)) return [];
  const calls = open.calls.map((call) => ({ callId: call.callId, output: outputOf(call), toolName: call.toolName }));
  const input = turn.historyStarted || turn.prepared === null
    ? []
    : turnInputMessages({ ...turn.input, userInstructions: turn.prepared.userInstructions });
  return [...input, ...stepHistoryMessages({ calls, response: open.step.response })];
}
