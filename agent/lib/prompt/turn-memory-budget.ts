/**
 * Total character budget for the turn memory block.
 *
 * Export:
 * - `applyTurnMemoryBudget`: drops whole records from the tail of the ranking until the block fits.
 *
 * Key constructs:
 * - The budget measures the assembled block, not the records on their own. Instructions, tags,
 *   separators and escaping are two and a half thousand characters on production, and a budget
 *   blind to them lets the block overshoot its own ceiling.
 * - A record is dropped whole or kept whole. Cutting one in half would hand the model a claim
 *   without its end, which reads as a complete fact and is not one.
 * - The best match is never dropped. The profile and thread parts are bounded by their own limits,
 *   which count rendered text while this budget counts the assembled block, so a large profile can
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

/**
 * `render` assembles the block the model will actually receive from the records it is given. Only
 * retrieved records are dropped: the ranking says which of them matters least, and nothing says
 * that about a profile subject or a thread.
 */
export function applyTurnMemoryBudget(input: {
  memories: readonly ModelMemoryContextItem[];
  render: (memories: readonly ModelMemoryContextItem[]) => string;
}): TurnMemoryBudget {
  const kept = [...input.memories];
  let droppedMemories = 0;
  while (
    kept.length > 1 && input.render(kept).length > MEMORY_TURN_BLOCK_MAX_CHARACTERS
  ) {
    kept.splice(droppableIndex(kept), 1);
    droppedMemories += 1;
  }
  return {
    droppedMemories,
    memories: kept,
    overBudget: input.render(kept).length > MEMORY_TURN_BLOCK_MAX_CHARACTERS,
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
