/**
 * What a failed or cancelled turn had already done, kept in the session history (#561).
 *
 * Export:
 * - `interruptedStep`: the history messages of the step the turn left open when any of its calls started,
 *   and the parked step it settles, if that is the open one.
 *
 * A step goes into history only once all its calls settle. Before this, a reminder created by a call of
 * a step that never finished was missing from history, and the next turn, asked again, created another.
 * The open step is the turn's own next step, or — for a continuation that has not written history yet —
 * the parked step whose approved calls it runs under the parked turn's journal. Every call of the step
 * gets a result, as the provider pairs results with calls: a call that settled keeps its own, one that
 * started and was cut off reads as of unknown outcome, one that never started reads as not run. Nothing is
 * repeated.
 */
import type { ModelMessage } from "ai";

import { turnInputMessages } from "../prompt/turn-instructions.js";
import { loadStep, loadTurn, type JournalClient } from "./journal-repository.js";
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

export interface InterruptedStep {
  readonly messages: readonly ModelMessage[];
  /** The parked step these messages settle; it is completed with them, as a continuation would. */
  readonly settlesParked: { readonly stepIndex: number; readonly turnId: string } | null;
}

const NOTHING: InterruptedStep = { messages: [], settlesParked: null };

function outputOf(call: ToolCallRecord): ToolResultOutput {
  if ((call.state === "completed" || call.state === "unknown") && call.output !== null) return call.output;
  if (call.state === "intent") return CUT_OFF_OUTPUT;
  return NOT_RUN_OUTPUT;
}

function started(call: ToolCallRecord): boolean {
  return call.state === "completed" || call.state === "unknown" || call.state === "intent";
}

/** `turn` must be read in the same transaction that appends the result, so its step index is current. */
export async function interruptedStep(client: JournalClient, turn: TurnRecord): Promise<InterruptedStep> {
  const continuing = turn.resumesTurnId !== null && !turn.historyStarted;
  const owner = continuing ? await loadTurn(client, turn.resumesTurnId!) : turn;
  const open = await loadStep(client, owner.id, owner.nextStepIndex);
  if (open === null || open.step.completed || !open.calls.some(started)) return NOTHING;
  const calls = open.calls.map((call) => ({ callId: call.callId, output: outputOf(call), toolName: call.toolName }));
  const step = stepHistoryMessages({ calls, response: open.step.response });
  if (continuing) {
    // As `settleParkedStep` writes it: the answer's context lines go before the restored parked step.
    const context = turn.input.context.map((entry): ModelMessage => ({ role: "user", content: entry }));
    return {
      messages: [...(turn.prepared?.userInstructions ?? []), ...context, ...step],
      settlesParked: { stepIndex: owner.nextStepIndex, turnId: owner.id },
    };
  }
  const input = turn.historyStarted || turn.prepared === null
    ? []
    : turnInputMessages({ ...turn.input, userInstructions: turn.prepared.userInstructions });
  return { messages: [...input, ...step], settlesParked: null };
}
