/**
 * How a turn that cannot go on ends: the failure becomes its stored outcome, logged once.
 *
 * Exports:
 * - `failTurn`: for the turn the loop runs; a cancellation is stored as cancelled.
 * - `failParkedTurn`: for a parked turn whose request cannot be shown at recovery. When the next
 *   turn took the session over meanwhile (a person answered an earlier card), the parked turn is
 *   left as that turn closed it and `null` is returned: failing it then would clear the next
 *   turn's approvals.
 *
 * Moved out of `run-turn.ts` (derived from eve 0.40.0 `harness/tool-loop.ts`, Apache-2.0, see
 * NOTICE-eve), so recovery fails a turn exactly as the loop does.
 */
import { AppError } from "../../lib/app-error.js";
import { failWaitingTurn, finishTurn, type JournalClient } from "./journal-repository.js";
import { TurnCancelledError } from "./model-errors.js";
import type { TurnOutcome } from "./run-turn.js";
import type { TurnRecord } from "./turn-types.js";

const TURN_FAILED_MESSAGE = "Не удалось выполнить ход агента. Попробуйте ещё раз";

function failureOf(turn: TurnRecord, error: unknown): { readonly code: string; readonly message: string } {
  const code = error instanceof AppError ? error.code : "AGENT_TURN_FAILED";
  console.error(JSON.stringify({
    code: "AGENT_TURN_FAILED",
    error: error instanceof Error ? error.message : String(error),
    errorCode: code,
    ...(error instanceof AppError && error.details !== undefined ? { details: error.details } : {}),
    ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.message } : {}),
    sessionId: turn.sessionId,
    turnId: turn.id,
  }));
  return { code, message: error instanceof AppError ? error.message.slice(code.length + 2) : TURN_FAILED_MESSAGE };
}

export async function failTurn(database: JournalClient, turn: TurnRecord, error: unknown, signal: AbortSignal): Promise<TurnOutcome> {
  if (error instanceof TurnCancelledError || signal.aborted) {
    await finishTurn(database, turn.id, { status: "cancelled" });
    return { status: "cancelled" };
  }
  const { code, message } = failureOf(turn, error);
  await finishTurn(database, turn.id, { errorCode: code, errorMessage: message, status: "failed" });
  return { code, message, status: "failed" };
}

export async function failParkedTurn(database: JournalClient, turn: TurnRecord, error: unknown): Promise<TurnOutcome | null> {
  const { code, message } = failureOf(turn, error);
  if (!await failWaitingTurn(database, turn.id, { errorCode: code, errorMessage: message })) return null;
  return { code, message, status: "failed" };
}
