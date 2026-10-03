/**
 * An `agent` call as a child turn: fresh history, the parent's tools and sandbox, one level deep.
 *
 * Exports:
 * - `runChildTurn`: starts the call's child turn, or continues the one it already started, and
 *   returns its result as the tool output the parent's model reads — or the child's requests
 *   when it waits for a person.
 * - `SILENT_OBSERVER`: a child's events stay inside the runtime; the parent reports the result.
 *
 * Key constructs:
 * - The child acts as the parent turn's caller: a turn's auth never changes while it runs, so a
 *   person who answered something meanwhile does not become the child's caller.
 * - The child is found by the parent call it serves, so a restart waits for the same child
 *   instead of starting another one; after an answer the child runs in its continuation turn.
 *
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { AppError } from "../../lib/app-error.js";
import { createSessionHistory, loadApplicationSessionId } from "../history/history-repository.js";
import type { InputRequest } from "../hitl/types.js";
import { newSessionId, newTurnId } from "../ids.js";
import { formatSubagentMessage, requestedOutputSchema } from "../tools/delegate.js";
import {
  createTurn, findChildTurn, inJournalTransaction, latestSessionTurn, loadStep,
} from "./journal-repository.js";
import type { runTurn, TurnObserver, TurnRuntime } from "./run-turn.js";
import type { ToolResultOutput } from "./tool-calls.js";
import type { SubagentInputRequest, ToolCallRecord, TurnRecord } from "./turn-types.js";

export type ChildTurnResult =
  | { readonly kind: "output"; readonly output: ToolResultOutput }
  | { readonly kind: "waiting"; readonly request: SubagentInputRequest };

export const SILENT_OBSERVER: TurnObserver = {
  async inputRequested() {},
  async stepText() {},
  async toolsStarted() {},
  async turnFinished() {},
  async turnStarted() {},
};

async function startChild(runtime: TurnRuntime, input: {
  readonly call: ToolCallRecord;
  readonly journalTurnId: string;
  readonly parent: TurnRecord;
}): Promise<TurnRecord> {
  const message = input.call.input.message;
  if (typeof message !== "string") {
    throw new AppError("AGENT_SUBAGENT_INPUT_INVALID", "Подзадаче не передано сообщение", { details: { callId: input.call.callId } });
  }
  const outputSchema = requestedOutputSchema(input.call.input.outputSchema);
  return await inJournalTransaction(runtime.database, async (client) => {
    const sessionId = newSessionId();
    await createSessionHistory(client, {
      announcedSkills: null,
      applicationSessionId: await loadApplicationSessionId(client, input.parent.sessionId),
      channelState: null,
      compaction: { inputTokens: null, promptMessageCount: null },
      history: [],
      initiatorAuth: input.parent.auth.initiator,
      parentSessionId: input.parent.sessionId,
      sandbox: null,
      sessionId,
      source: "runtime",
      todo: null,
    });
    return await createTurn(client, {
      auth: input.parent.auth,
      channel: { kind: "subagent" },
      id: newTurnId(),
      input: { context: [], message: formatSubagentMessage(message), ...(outputSchema === undefined ? {} : { outputSchema }) },
      kind: "subagent",
      parent: { callId: input.call.callId, turnId: input.journalTurnId },
      resumesTurnId: null,
      sessionId,
    });
  });
}

async function waitingRequests(runtime: TurnRuntime, child: TurnRecord): Promise<SubagentInputRequest> {
  const recorded = await loadStep(runtime.database, child.id, child.nextStepIndex);
  const requests: InputRequest[] = [];
  for (const call of recorded?.calls ?? []) {
    if (call.state !== "awaiting_input" || call.inputRequest === null) continue;
    if (call.inputRequest.kind === "subagent") throw new Error("AGENT_SUBAGENT_NESTED: a child turn cannot delegate again");
    requests.push(call.inputRequest);
  }
  if (requests.length === 0) throw new Error(`AGENT_TURN_PARKED_STEP_MISSING: child turn ${child.id} waits without a request`);
  return { childSessionId: child.sessionId, kind: "subagent", requests };
}

function resultOutput(child: TurnRecord): ToolResultOutput {
  if (child.status === "completed") {
    if (child.input.outputSchema !== undefined) return { type: "json", value: JSON.parse(child.finalText!) };
    return { type: "text", value: child.finalText ?? "" };
  }
  if (child.status === "failed") return { type: "error-text", value: `${child.errorCode}: ${child.errorMessage}` };
  return { type: "error-text", value: "AGENT_SUBAGENT_CANCELLED: The subagent was stopped before it finished." };
}

export async function runChildTurn(runtime: TurnRuntime, input: {
  readonly call: ToolCallRecord;
  /** The turn the call is recorded in: a continuation settles calls of the turn it resumes. */
  readonly journalTurnId: string;
  readonly parent: TurnRecord;
  /** `runTurn`, passed in: the turn loop calls this module, so it does not import the loop back. */
  readonly run: typeof runTurn;
  readonly signal: AbortSignal;
}): Promise<ChildTurnResult> {
  const first = await findChildTurn(runtime.database, input.journalTurnId, input.call.callId)
    ?? await startChild(runtime, input);
  const childRuntime: TurnRuntime = {
    ...runtime,
    observer: SILENT_OBSERVER,
    // The child works in the parent's sandbox: same files, same container.
    sandbox: () => runtime.sandbox({ auth: input.parent.auth, id: input.parent.sessionId }),
  };
  let child = await latestSessionTurn(runtime.database, first.sessionId);
  if (child.status === "running") {
    const outcome = await input.run(childRuntime, child.id, { abortSignal: input.signal });
    if (outcome.status === "busy") {
      throw new AppError("AGENT_SUBAGENT_BUSY", "Подзадачу уже выполняет другой процесс", { details: { childTurnId: child.id } });
    }
    child = await latestSessionTurn(runtime.database, first.sessionId);
  }
  if (child.status === "waiting_input") return { kind: "waiting", request: await waitingRequests(runtime, child) };
  return { kind: "output", output: resultOutput(child) };
}
