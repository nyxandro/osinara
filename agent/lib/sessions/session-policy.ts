/**
 * Durable session rotation policy.
 *
 * Exports:
 * - `SessionRotationState`: persisted fields used by the decision.
 * - `continuationTokenForGeneration`: preserves generation-zero compatibility.
 * - `sessionNeedsRotation`: applies inactivity, manual, and pending-operation rules. A long
 *   conversation is not rotated by its turn count: history compaction keeps it in the context.
 */
import { SESSION_INACTIVITY_DAYS } from "../../config.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface SessionRotationState {
  completedTurns: number;
  lastActivityAt: Date;
  now: Date;
  pendingOperation: boolean;
  rotationRequestedAt: Date | null;
}

export function continuationTokenForGeneration(baseToken: string, generation: number): string {
  // Generation zero keeps the original key, so a chat keeps its address across releases.
  return generation === 0 ? baseToken : `${baseToken}:osinara:${generation}`;
}

export function sessionNeedsRotation(state: SessionRotationState): boolean {
  // An approval or authorization must resume the exact session that requested it.
  if (state.pendingOperation) return false;

  const inactivityCutoff = state.now.getTime() - SESSION_INACTIVITY_DAYS * MILLISECONDS_PER_DAY;
  return state.rotationRequestedAt !== null || state.lastActivityAt.getTime() < inactivityCutoff;
}
