/**
 * What the automatic selection has already put in front of the model in this conversation.
 *
 * Exports:
 * - `MemorySelectionWindow`: the conversation and turn the current selection belongs to.
 * - `memoryShowJournal.openTurn`: gives this turn its number inside the conversation.
 * - `memoryShowJournal.recordShown`: writes down what the selection offered this turn.
 *
 * The selection is built fresh every turn and used to know nothing about the turns before it. Rank
 * fusion is stable by construction, so a similar question inside one conversation brings up the
 * same records, and measured on production that was half of all shows: 348 shows over 178 distinct
 * records, one of them holding a slot in fourteen turns out of twenty-nine. Every repeat pushes out
 * a record the model has not seen.
 *
 * The window is counted in turns rather than in time, so a quiet chat behaves like a busy one and
 * the selection does not depend on how long somebody was away.
 */
import { database } from "./database.js";

export interface MemorySelectionWindow {
  conversationId: string;
  turnId: string;
  /** Position of this turn inside its conversation, from `openTurn`. */
  turnOrdinal: number;
}

export const memoryShowJournal = {
  /**
   * The number is handed out once per turn: re-processing the same turn must not move the window,
   * or a retried turn would suppress what the first attempt had shown and answer differently.
   */
  async openTurn(conversationId: string, turnId: string): Promise<number> {
    const opened = await database().query<{ turn_ordinal: string }>(
      `INSERT INTO memory_retrieval_turns (conversation_id, turn_id, turn_ordinal)
       SELECT $1, $2, coalesce(max(turn_ordinal), 0) + 1
       FROM memory_retrieval_turns WHERE conversation_id = $1
       ON CONFLICT (conversation_id, turn_id) DO UPDATE SET turn_id = EXCLUDED.turn_id
       RETURNING turn_ordinal`,
      [conversationId, turnId],
    );
    return Number(opened.rows[0]!.turn_ordinal);
  },

  async recordShown(window: MemorySelectionWindow, claimIds: readonly string[]): Promise<void> {
    if (claimIds.length === 0) return;
    await database().query(
      `INSERT INTO memory_retrieval_shows (conversation_id, turn_id, turn_ordinal, claim_id)
       SELECT $1, $2, $3, claim FROM unnest($4::uuid[]) AS claim
       ON CONFLICT (conversation_id, turn_id, claim_id) DO NOTHING`,
      [window.conversationId, window.turnId, window.turnOrdinal, [...claimIds]],
    );
  },
};
