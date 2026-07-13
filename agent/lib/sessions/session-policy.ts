/**
 * Durable session rotation policy.
 *
 * Exports:
 * - `SessionRotationState`: persisted fields used by the decision.
 * - `continuationTokenForGeneration`: preserves generation-zero compatibility.
 * - `sessionNeedsRotation`: applies inactivity, turn, manual, and pending-operation rules.
 */
import {
  SESSION_INACTIVITY_DAYS,
  SESSION_MAX_COMPLETED_TURNS,
} from "../../config.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface SessionRotationState {
  completedTurns: number;
  lastActivityAt: Date;
  now: Date;
  pendingOperation: boolean;
  rotationRequestedAt: Date | null;
}

export function continuationTokenForGeneration(baseToken: string, generation: number): string {
  // Generation zero deliberately retains Eve's old key so deploy does not reset live chats.
  return generation === 0 ? baseToken : `${baseToken}:osinara:${generation}`;
}

export function sessionNeedsRotation(state: SessionRotationState): boolean {
  // An approval or authorization must resume the exact session that requested it.
  if (state.pendingOperation) return false;

  const inactivityCutoff = state.now.getTime() - SESSION_INACTIVITY_DAYS * MILLISECONDS_PER_DAY;
  return state.rotationRequestedAt !== null ||
    state.completedTurns >= SESSION_MAX_COMPLETED_TURNS ||
    state.lastActivityAt.getTime() < inactivityCutoff;
}
