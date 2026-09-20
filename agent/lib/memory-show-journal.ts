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
 *
 * The journal is not an archive: opening a turn drops everything older than the kept depth, which
 * holds each conversation to a fixed number of rows instead of twelve more every turn forever.
 *
 * A turn is identified by the Eve session together with the turn id, never by the turn id alone.
 * Eve numbers turns inside a session — `turn_0`, `turn_1`, … — and the session is replaced every
 * fifty completed turns, so inside one long-lived conversation those names come round again.
 */
import { database } from "./database.js";
import { MEMORY_RETRIEVAL_SHOW_JOURNAL_RETAINED_TURNS } from "./memory-config.js";

export interface MemorySelectionWindow {
  conversationId: string;
  eveSessionId: string;
  turnId: string;
  /** Position of this turn inside its conversation, from `openTurn`. */
  turnOrdinal: number;
}

export const memoryShowJournal = {
  /**
   * The number is handed out once per turn: re-processing the same turn must not move the window,
   * or a retried turn would suppress what the first attempt had shown and answer differently.
   */
  async openTurn(conversationId: string, eveSessionId: string, turnId: string): Promise<number> {
    const opened = await database().query<{ turn_ordinal: string }>(
      `WITH opened AS (
         INSERT INTO memory_retrieval_turns
           (conversation_id, eve_session_id, turn_id, turn_ordinal)
         SELECT $1, $2, $3, coalesce(max(turn_ordinal), 0) + 1
         FROM memory_retrieval_turns WHERE conversation_id = $1
         ON CONFLICT (conversation_id, eve_session_id, turn_id)
           DO UPDATE SET turn_id = EXCLUDED.turn_id
         RETURNING turn_ordinal
       ),
       -- Everything older than the kept depth is unreachable: the window never looks that far
       -- back and no retry lives that long. Both deletes see the journal as it was before this
       -- turn was opened, so they cannot touch the rows this turn is about to write.
       pruned_shows AS (
         DELETE FROM memory_retrieval_shows
         WHERE conversation_id = $1
           AND turn_ordinal <= (SELECT turn_ordinal FROM opened) - $4::bigint
       ),
       pruned_turns AS (
         DELETE FROM memory_retrieval_turns
         WHERE conversation_id = $1
           AND turn_ordinal <= (SELECT turn_ordinal FROM opened) - $4::bigint
       )
       SELECT turn_ordinal FROM opened`,
      [conversationId, eveSessionId, turnId, MEMORY_RETRIEVAL_SHOW_JOURNAL_RETAINED_TURNS],
    );
    return Number(opened.rows[0]!.turn_ordinal);
  },

  async recordShown(window: MemorySelectionWindow, claimIds: readonly string[]): Promise<void> {
    if (claimIds.length === 0) return;
    await database().query(
      `INSERT INTO memory_retrieval_shows
         (conversation_id, eve_session_id, turn_id, turn_ordinal, claim_id)
       SELECT $1, $2, $3, $4, claim FROM unnest($5::uuid[]) AS claim
       ON CONFLICT (conversation_id, eve_session_id, turn_id, claim_id) DO NOTHING`,
      [
        window.conversationId,
        window.eveSessionId,
        window.turnId,
        window.turnOrdinal,
        [...claimIds],
      ],
    );
  },
};
