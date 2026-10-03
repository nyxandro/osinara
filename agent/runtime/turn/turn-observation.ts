/**
 * What the application hears about a turn that is no longer running, and hearing it again after a crash.
 *
 * Exports:
 * - `storedTurnOutcome`: a finished or parked turn's outcome from the journal, with the requests
 *   it waits on — its own and those its child raised.
 * - `reportUnobservedTurn`: for a turn whose process died before the application heard of it,
 *   shows its request if it was never shown, then reports how its run ended. A request that cannot
 *   be shown fails the turn, as it would have in the run itself — unless a person answered an
 *   earlier card meanwhile: then the next turn has the session and reports, and nothing is changed.
 *
 * The turn loop marks both steps in the journal (`markInputPresented`, `markFinishObserved`), so
 * recovery reports only what a dead process left unreported. A request shown just before the crash,
 * before its mark, is shown once more; the channel binds its buttons to the newest card.
 */
import type { InputRequest } from "../hitl/types.js";
import { loadStep, markFinishObserved, markInputPresented, type JournalClient } from "./journal-repository.js";
import type { TurnOutcome, TurnRuntime } from "./run-turn.js";
import { failParkedTurn } from "./turn-failure.js";
import type { SubagentInputRequest, TurnRecord } from "./turn-types.js";

export async function storedTurnOutcome(client: JournalClient, turn: TurnRecord): Promise<TurnOutcome> {
  switch (turn.status) {
    case "completed":
      return { status: "completed", text: turn.finalText };
    case "failed":
      return { code: turn.errorCode!, message: turn.errorMessage!, status: "failed" };
    case "cancelled":
      return { status: "cancelled" };
    case "waiting_input": {
      const recorded = await loadStep(client, turn.id, turn.nextStepIndex);
      const awaiting = recorded?.calls.filter((call) => call.state === "awaiting_input" && call.inputRequest !== null) ?? [];
      const own = awaiting.flatMap((call) => call.inputRequest!.kind === "subagent" ? [] : [call.inputRequest as InputRequest]);
      const proxied = awaiting.flatMap((call) => call.inputRequest!.kind === "subagent" ? (call.inputRequest as SubagentInputRequest).requests : []);
      return { requests: [...own, ...proxied], status: "waiting_input" };
    }
    case "running":
      throw new Error(`AGENT_TURN_STILL_RUNNING: turn ${turn.id} has no outcome yet`);
  }
}

async function presentAgain(runtime: TurnRuntime, turn: TurnRecord, outcome: TurnOutcome & { readonly status: "waiting_input" }): Promise<TurnOutcome | null> {
  try {
    await runtime.observer.inputRequested({ requests: outcome.requests, stepIndex: turn.nextStepIndex, turn });
  } catch (error) {
    return await failParkedTurn(runtime.database, turn, error);
  }
  await markInputPresented(runtime.database, turn.id);
  return outcome;
}

export async function reportUnobservedTurn(runtime: TurnRuntime, input: {
  readonly inputPresented: boolean;
  readonly turn: TurnRecord;
}): Promise<void> {
  const { turn } = input;
  let outcome: TurnOutcome | null = await storedTurnOutcome(runtime.database, turn);
  if (outcome.status === "waiting_input" && !input.inputPresented) outcome = await presentAgain(runtime, turn, outcome);
  if (outcome === null) return;
  try {
    await runtime.observer.turnFinished({ outcome, turn });
  } finally {
    await markFinishObserved(runtime.database, turn.id);
  }
}
