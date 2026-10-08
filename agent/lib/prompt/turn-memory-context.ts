/**
 * Turn-scoped memory payload boundary.
 *
 * Exports:
 * - `TURN_MEMORY_OPEN_TAG` / `TURN_MEMORY_CLOSE_TAG`: the markers that delimit the payload.
 * - `formatTurnMemoryContext`: wraps one turn's authorized records as untrusted data.
 * - `isTurnMemoryContext`: whether an instruction block is such a payload, as that function wrote it.
 *
 * Only retrieved data carries these markers. A service notice about memory is a rule about
 * behaviour, so it stays unwrapped in the instruction prefix; `turn-memory-projection.ts` moves
 * exactly what the markers delimit and nothing else.
 */
export const TURN_MEMORY_OPEN_TAG = "<osinara_turn_memory>";
export const TURN_MEMORY_CLOSE_TAG = "</osinara_turn_memory>";

/** Supplemental, turn-scoped context; never a new user request or durable history. */
export function formatTurnMemoryContext(content: string): string {
  return `${TURN_MEMORY_OPEN_TAG}\n${content}\n${TURN_MEMORY_CLOSE_TAG}`;
}

export function isTurnMemoryContext(block: string): boolean {
  return block.startsWith(`${TURN_MEMORY_OPEN_TAG}\n`) && block.endsWith(`\n${TURN_MEMORY_CLOSE_TAG}`);
}
