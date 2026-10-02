/**
 * Creating turns: a new input, or a person's answer to a parked turn.
 *
 * Exports:
 * - `startTurn`: a turn for new input. A new message dismisses a parked question: the question is
 *   answered as ignored and the new turn writes that exchange into history before its own input.
 * - `respondToInput`: records answers on the parked turn's calls. Once they release the step, the
 *   parked turn ends and a continuation turn is created; the caller runs it with `runTurn`.
 *
 * Derived from eve 0.40.0 `harness/input-requests.ts` (`resolvePendingInput`),
 * `harness/hitl/approval-input-requests.ts`, `harness/hitl/question-input-requests.ts` and
 * `harness/pending-input-batches.ts` (Apache-2.0, see NOTICE-eve). Changes:
 * - A session has at most one parked turn: while an approval waits, other turns run without tools,
 *   and a new message dismisses a waiting question, so Eve's list of open batches is one step here.
 * - A partial answer to several approvals stays on its call; its context lines wait on the parked
 *   turn for the continuation.
 * - Answers that match no waiting request are returned to the caller, which decides how the model
 *   hears about them (Eve turned them into a user message).
 */
import type { SessionAuth } from "../context.js";
import { questionOutput, resolveApprovalOutcome, deniedOutput, stepInputResolved } from "../hitl/input-requests.js";
import type { InputResponse } from "../hitl/types.js";
import { newTurnId } from "../ids.js";
import {
  addPendingContext, createTurn, findWaitingTurn, finishTurn, inJournalTransaction, loadStep, recordInputResponse,
  updateToolCall, type JournalClient, type JournalDatabase,
} from "./journal-repository.js";
import type { ToolCallRecord, TurnChannel, TurnKind, TurnRecord, TurnStartInput } from "./turn-types.js";

async function parkedCalls(client: JournalClient, turn: TurnRecord): Promise<ToolCallRecord[]> {
  const recorded = await loadStep(client, turn.id, turn.nextStepIndex);
  const awaiting = recorded?.calls.filter((call) => call.state === "awaiting_input") ?? [];
  if (awaiting.length === 0) throw new Error(`AGENT_TURN_PARKED_STEP_MISSING: turn ${turn.id} waits without a request`);
  return awaiting;
}

export async function startTurn(database: JournalDatabase, input: {
  readonly auth: SessionAuth;
  readonly channel: TurnChannel;
  readonly input: TurnStartInput;
  readonly kind: TurnKind;
  readonly parent: { readonly callId: string; readonly turnId: string } | null;
  readonly sessionId: string;
}): Promise<TurnRecord> {
  return await inJournalTransaction(database, async (client) => {
    const waiting = await findWaitingTurn(client, input.sessionId);
    let resumesTurnId: string | null = null;
    if (waiting !== null && input.input.message !== undefined) {
      const awaiting = await parkedCalls(client, waiting);
      if (awaiting.every((call) => call.inputRequest?.kind === "question")) {
        for (const call of awaiting) {
          await updateToolCall(client, { callId: call.callId, output: questionOutput(undefined), state: "completed", turnId: waiting.id });
        }
        await finishTurn(client, waiting.id, { finalText: null, status: "completed" });
        resumesTurnId = waiting.id;
      }
    }
    return await createTurn(client, { ...input, id: newTurnId(), resumesTurnId });
  });
}

export type InputResponseOutcome =
  | { readonly continuation: TurnRecord; readonly stale: readonly InputResponse[]; readonly status: "resumed" }
  | { readonly stale: readonly InputResponse[]; readonly status: "waiting"; readonly turnId: string }
  | { readonly stale: readonly InputResponse[]; readonly status: "stale" };

async function settleCall(client: JournalClient, turnId: string, call: ToolCallRecord, response: InputResponse | undefined) {
  if (call.inputRequest?.kind === "tool-approval") {
    const outcome = resolveApprovalOutcome(response);
    await updateToolCall(client, outcome.approved
      ? { callId: call.callId, output: null, state: "planned", turnId }
      : { callId: call.callId, output: deniedOutput(outcome.reason), state: "completed", turnId });
    return;
  }
  await updateToolCall(client, { callId: call.callId, output: questionOutput(response), state: "completed", turnId });
}

export async function respondToInput(database: JournalDatabase, input: {
  /** Who answered; the continuation acts as them. */
  readonly auth: SessionAuth;
  readonly channel: TurnChannel;
  readonly context: readonly string[];
  readonly responses: readonly InputResponse[];
  readonly sessionId: string;
}): Promise<InputResponseOutcome> {
  return await inJournalTransaction(database, async (client) => {
    const waiting = await findWaitingTurn(client, input.sessionId);
    if (waiting === null) return { stale: input.responses, status: "stale" };
    const awaiting = await parkedCalls(client, waiting);
    const byRequest = new Map(awaiting.map((call) => [call.inputRequest!.requestId, call]));
    const latest = new Map(input.responses.map((response) => [response.requestId, response]));
    const stale = [...latest.values()].filter((response) => !byRequest.has(response.requestId));
    if (stale.length === latest.size) return { stale, status: "stale" };

    const answers = new Map<string, InputResponse>();
    for (const call of awaiting) {
      const response = latest.get(call.inputRequest!.requestId) ?? call.inputResponse ?? undefined;
      if (response === undefined) continue;
      answers.set(call.inputRequest!.requestId, response);
      if (latest.has(call.inputRequest!.requestId)) {
        await recordInputResponse(client, { callId: call.callId, response, turnId: waiting.id });
      }
    }
    if (!stepInputResolved(awaiting.map((call) => call.inputRequest!), answers)) {
      await addPendingContext(client, waiting.id, input.context);
      return { stale, status: "waiting", turnId: waiting.id };
    }
    for (const call of awaiting) await settleCall(client, waiting.id, call, answers.get(call.inputRequest!.requestId));
    await finishTurn(client, waiting.id, { finalText: null, status: "completed" });
    const continuation = await createTurn(client, {
      auth: input.auth,
      channel: input.channel,
      id: newTurnId(),
      input: { context: [...waiting.pendingContext, ...input.context] },
      kind: waiting.kind,
      parent: null,
      resumesTurnId: waiting.id,
      sessionId: input.sessionId,
    });
    return { continuation, stale, status: "resumed" };
  });
}
