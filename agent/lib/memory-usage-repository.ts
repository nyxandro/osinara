/**
 * Writing down that a record was actually used in an answer.
 *
 * Export:
 * - `memoryUsageRepository.recordUsed`: counts only records this session had already shown.
 *
 * The rule the barrier enforces: a record can be marked as used only if the model was shown it in
 * this session of the conversation — by a turn's automatic selection, by its own search or list, or
 * by the profile — within the turns the show journal keeps. Opaque refs are capabilities for
 * reading, not a licence to reach back into memory, and a model that named a ref it was never
 * given is either confused or repeating something it cannot have seen. Either way it is not
 * evidence that the record was useful, and it is written to the log instead of to the counter.
 * Another session of the same conversation does not count: its history is not in front of this one.
 *
 * Until #339 only the current turn's automatic selection counted, so a record found by a search or
 * shown a turn earlier aged on the forgetting curve as if nobody had ever needed it — exactly the
 * records the selection had missed and the model had to look for.
 *
 * The counter moves once per show and once per answer, never once per delivery attempt. Naming a
 * record takes the latest show not yet spent and marks which turn spent it; the turn can be
 * processed again — a redelivery, a retried worker — and finds its own mark instead of spending the
 * next show.
 *
 * The counter is separate from `reinforcement_count` on purpose. That one means a fact was
 * observed again; this one means a record earned its place in an answer.
 */
import { database } from "./database.js";
import type { MemorySelectionWindow } from "./memory-show-journal.js";

export interface MemoryUsageOutcome {
  /** Records whose counter moved on this call, as opposed to an earlier pass over the same turn. */
  counted: string[];
  /**
   * Of `counted`, the ones the automatic selection had offered. The share of the offer the answers
   * use is about these: a record the model found by its own search was never part of the offer.
   */
  countedFromSelection: string[];
  /** Refs the model named that this session had not shown it. */
  rejected: string[];
  /** Refs the model named that this session really had shown. */
  used: string[];
}

export const memoryUsageRepository = {
  async recordUsed(
    window: Pick<MemorySelectionWindow, "conversationId" | "agentSessionId" | "turnId">,
    memoryRefs: readonly string[],
  ): Promise<MemoryUsageOutcome> {
    if (memoryRefs.length === 0) return { counted: [], countedFromSelection: [], rejected: [], used: [] };
    const outcome = await database().query<{ counted_source: string | null; memory_ref: string }>(
      `WITH named AS (
         SELECT DISTINCT ref AS memory_ref FROM unnest($4::text[]) AS ref
       ),
       -- Shows of this session up to this turn. A turn that opened no window — an answer after an
       -- approval — reads every show the session's journal still keeps.
       current_turn AS (
         SELECT turn_ordinal FROM memory_retrieval_turns
         WHERE conversation_id = $1 AND agent_session_id = $2 AND turn_id = $3
       ),
       shown AS (
         SELECT named.memory_ref, show.claim_id, show.turn_id, show.turn_ordinal, show.used_at,
                show.used_turn_id, show.source
         FROM named
         JOIN memory_item_refs AS ref ON ref.memory_ref = named.memory_ref
         JOIN memory_items AS item ON item.id = ref.memory_item_id AND item.claim_status = 'active'
         JOIN memory_retrieval_shows AS show ON show.claim_id = ref.memory_item_id
          AND show.conversation_id = $1 AND show.agent_session_id = $2
          AND (NOT EXISTS (SELECT 1 FROM current_turn)
               OR show.turn_ordinal <= (SELECT turn_ordinal FROM current_turn))
       ),
       spent_by_this_turn AS (
         SELECT DISTINCT claim_id FROM shown WHERE used_turn_id = $3
       ),
       target AS (
         SELECT DISTINCT ON (claim_id) claim_id, turn_id, source
         FROM shown
         WHERE used_at IS NULL AND claim_id NOT IN (SELECT claim_id FROM spent_by_this_turn)
         ORDER BY claim_id, turn_ordinal DESC
       ),
       claimed AS (
         UPDATE memory_retrieval_shows AS show
         SET used_at = now(), used_turn_id = $3
         FROM target
         WHERE show.conversation_id = $1 AND show.agent_session_id = $2
           AND show.turn_id = target.turn_id AND show.claim_id = target.claim_id
           AND show.used_at IS NULL
         RETURNING show.claim_id
       ),
       counted AS (
         UPDATE memory_items AS item
         SET usage_count = item.usage_count + 1, last_used_at = now()
         FROM claimed
         WHERE item.id = claimed.claim_id
         RETURNING item.id
       )
       -- A data-modifying CTE always runs to completion, so the counters move whether or not the
       -- final select reads them; it reports what was shown, which of it the counter just took and
       -- from which show.
       SELECT DISTINCT shown.memory_ref, target.source AS counted_source
       FROM shown LEFT JOIN target ON target.claim_id = shown.claim_id`,
      [window.conversationId, window.agentSessionId, window.turnId, [...memoryRefs]],
    );
    const used = outcome.rows.map((row) => row.memory_ref);
    return {
      counted: outcome.rows.filter((row) => row.counted_source !== null).map((row) => row.memory_ref),
      countedFromSelection: outcome.rows.filter((row) => row.counted_source === "selection").map((row) => row.memory_ref),
      rejected: memoryRefs.filter((ref) => !used.includes(ref)),
      used,
    };
  },
};
