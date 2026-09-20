/**
 * Writing down that a record was actually used in an answer.
 *
 * Export:
 * - `memoryUsageRepository.recordUsed`: counts only records this turn had already shown.
 *
 * The rule the barrier enforces: a record can be marked as used only if the automatic selection
 * put it in front of the model in this same turn. Opaque refs are capabilities for reading, not a
 * licence to reach back into memory, and a model that named a ref it was never given is either
 * confused or repeating something from earlier in the conversation. Either way it is not evidence
 * that the record was useful, and it is written to the log instead of to the counter.
 *
 * The counter moves once per show, never once per delivery attempt. The turn can be processed
 * again — a redelivery, a retried worker — and the journal row carries `used_at` precisely so the
 * second pass recognizes its own earlier work instead of counting the same answer twice.
 *
 * The counter is separate from `reinforcement_count` on purpose. That one means a fact was
 * observed again; this one means a record earned its place in an answer.
 */
import { database } from "./database.js";
import type { MemorySelectionWindow } from "./memory-show-journal.js";

export interface MemoryUsageOutcome {
  /** Records whose counter moved on this call, as opposed to an earlier pass over the same turn. */
  counted: string[];
  /** Refs the model named that this turn had not shown it. */
  rejected: string[];
  /** Refs the model named that this turn really had shown. */
  used: string[];
}

export const memoryUsageRepository = {
  async recordUsed(
    window: Pick<MemorySelectionWindow, "conversationId" | "eveSessionId" | "turnId">,
    memoryRefs: readonly string[],
  ): Promise<MemoryUsageOutcome> {
    if (memoryRefs.length === 0) return { counted: [], rejected: [], used: [] };
    const outcome = await database().query<{ counted: boolean; memory_ref: string }>(
      `WITH named AS (
         SELECT DISTINCT ref AS memory_ref FROM unnest($4::text[]) AS ref
       ),
       shown AS (
         SELECT named.memory_ref, show.claim_id, show.used_at
         FROM named
         JOIN memory_item_refs AS ref ON ref.memory_ref = named.memory_ref
         JOIN memory_retrieval_shows AS show ON show.claim_id = ref.memory_item_id
          AND show.conversation_id = $1 AND show.eve_session_id = $2 AND show.turn_id = $3
         JOIN memory_items AS item ON item.id = ref.memory_item_id
          AND item.claim_status = 'active'
       ),
       claimed AS (
         UPDATE memory_retrieval_shows AS show
         SET used_at = now()
         FROM shown
         WHERE show.conversation_id = $1 AND show.eve_session_id = $2 AND show.turn_id = $3
           AND show.claim_id = shown.claim_id AND show.used_at IS NULL
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
       -- final select reads them; it reports what was shown and which of it the counter just took.
       SELECT shown.memory_ref, (shown.used_at IS NULL) AS counted FROM shown`,
      [window.conversationId, window.eveSessionId, window.turnId, [...memoryRefs]],
    );
    const used = outcome.rows.map((row) => row.memory_ref);
    return {
      counted: outcome.rows.filter((row) => row.counted).map((row) => row.memory_ref),
      rejected: memoryRefs.filter((ref) => !used.includes(ref)),
      used,
    };
  },
};
