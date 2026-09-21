/**
 * Total character budget for the turn memory block.
 *
 * Exports:
 * - `turnMemoryBlockCharacters`: the block size as `AGENT_MEMORY_RETRIEVAL_METRICS` measures it.
 * - `applyTurnMemoryBudget`: drops whole records from the tail of the ranking until the block fits.
 *
 * Key constructs:
 * - A record is dropped whole or kept whole. Cutting one in half would hand the model a claim
 *   without its end, which reads as a complete fact and is not one.
 * - The best match is never dropped. The profile and thread parts are bounded by their own limits,
 *   which count rendered text while this budget counts the serialized block, so a large profile can
 *   fill the ceiling on its own. Answering that by handing the model no memory at all would be the
 *   failure this ceiling exists to avoid; the caller is told instead.
 */
import { MEMORY_TURN_BLOCK_MAX_CHARACTERS } from "../memory-config.js";
import type { ModelMemoryContextItem } from "../memory-retrieval.js";

export interface TurnMemoryBudget {
  droppedMemories: number;
  memories: readonly ModelMemoryContextItem[];
  /** The block still exceeds the ceiling with nothing left to drop: a signal, not normal trimming. */
  overBudget: boolean;
}

/** Same measure as the retrieval metrics line, so the budget and the log cannot disagree. */
export function turnMemoryBlockCharacters(
  memories: readonly ModelMemoryContextItem[],
  otherCharacters: number,
): number {
  return JSON.stringify(memories).length + otherCharacters;
}

/**
 * `otherCharacters` is the profile and thread part of the block. Only retrieved records are
 * dropped: the ranking says which of them matters least, and nothing says that about a profile
 * subject or a thread.
 */
export function applyTurnMemoryBudget(input: {
  memories: readonly ModelMemoryContextItem[];
  otherCharacters: number;
}): TurnMemoryBudget {
  const kept = [...input.memories];
  let droppedMemories = 0;
  while (
    kept.length > 1 &&
    turnMemoryBlockCharacters(kept, input.otherCharacters) > MEMORY_TURN_BLOCK_MAX_CHARACTERS
  ) {
    kept.splice(droppableIndex(kept), 1);
    droppedMemories += 1;
  }
  return {
    droppedMemories,
    memories: kept,
    overBudget:
      turnMemoryBlockCharacters(kept, input.otherCharacters) > MEMORY_TURN_BLOCK_MAX_CHARACTERS,
  };
}

/**
 * An unresolved conflict is the signal that one fact has two live versions. Dropping it leaves the
 * surviving version looking like the only truth, so conflicts go last even when the ranking put
 * them at the tail.
 */
function droppableIndex(memories: readonly ModelMemoryContextItem[]): number {
  for (let index = memories.length - 1; index >= 1; index -= 1) {
    if (!("versions" in memories[index]!)) return index;
  }
  return memories.length - 1;
}
