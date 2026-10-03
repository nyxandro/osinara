/**
 * How a turn that cannot go on ends: the failure becomes its stored outcome, logged once.
 *
 * Exports:
 * - `failTurn`: for the turn the loop runs; a cancellation is stored as cancelled.
 * - `failParkedTurn`: for a parked turn whose request could not be shown. When the next turn took
 *   the session over meanwhile (a new message dismissed a question, a person answered an earlier
 *   card), the parked turn is left as that turn closed it and `null` is returned: failing it then
 *   would send a failure notice and clear the next turn's approvals.
 * - `ParkedTurnTakenOver`: what the loop throws in that case; the run ends without a report.
 *
 * Shared by the loop and recovery, so recovery fails a turn exactly as the loop does.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { AppError } from "../../lib/app-error.js";
import { failWaitingTurn, finishTurn, type JournalClient } from "./journal-repository.js";
import { TurnCancelledError } from "./model-errors.js";
import type { TurnOutcome } from "./run-turn.js";
import type { TurnRecord } from "./turn-types.js";

const TURN_FAILED_MESSAGE = "Не удалось выполнить ход агента. Попробуйте ещё раз";

export class ParkedTurnTakenOver extends Error {
  constructor(turnId: string) {
    super(`AGENT_TURN_TAKEN_OVER: turn ${turnId} was closed by the next turn while its request was shown`);
  }
}

function failureOf(error: unknown): { readonly code: string; readonly message: string } {
  const code = error instanceof AppError ? error.code : "AGENT_TURN_FAILED";
  return { code, message: error instanceof AppError ? error.message.slice(code.length + 2) : TURN_FAILED_MESSAGE };
}

function logFailure(logCode: string, turn: TurnRecord, error: unknown, errorCode: string): void {
  console.error(JSON.stringify({
    code: logCode,
    error: error instanceof Error ? error.message : String(error),
    errorCode,
    ...(error instanceof AppError && error.details !== undefined ? { details: error.details } : {}),
    ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.message } : {}),
    sessionId: turn.sessionId,
    turnId: turn.id,
  }));
}

export async function failTurn(database: JournalClient, turn: TurnRecord, error: unknown, signal: AbortSignal): Promise<TurnOutcome> {
  if (error instanceof TurnCancelledError || signal.aborted) {
    await finishTurn(database, turn.id, { status: "cancelled" });
    return { status: "cancelled" };
  }
  const { code, message } = failureOf(error);
  logFailure("AGENT_TURN_FAILED", turn, error, code);
  await finishTurn(database, turn.id, { errorCode: code, errorMessage: message, status: "failed" });
  return { code, message, status: "failed" };
}

export async function failParkedTurn(database: JournalClient, turn: TurnRecord, error: unknown): Promise<TurnOutcome | null> {
  const { code, message } = failureOf(error);
  if (!await failWaitingTurn(database, turn.id, { errorCode: code, errorMessage: message })) {
    logFailure("AGENT_TURN_INPUT_PRESENTATION_FAILED_AFTER_TAKEOVER", turn, error, code);
    return null;
  }
  logFailure("AGENT_TURN_FAILED", turn, error, code);
  return { code, message, status: "failed" };
}
