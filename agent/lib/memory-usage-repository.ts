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
 * The counter is separate from `reinforcement_count` on purpose. That one means a fact was
 * observed again; this one means a record earned its place in an answer.
 */
import { database } from "./database.js";
import type { MemorySelectionWindow } from "./memory-show-journal.js";

export interface MemoryUsageOutcome {
  /** Refs the model named that this turn had not shown it. */
  rejected: string[];
  /** Records whose counter moved. */
  used: string[];
}

export const memoryUsageRepository = {
  async recordUsed(
    window: MemorySelectionWindow,
    memoryRefs: readonly string[],
  ): Promise<MemoryUsageOutcome> {
    if (memoryRefs.length === 0) return { rejected: [], used: [] };
    const updated = await database().query<{ memory_ref: string }>(
      `WITH shown AS (
         SELECT ref.memory_ref, ref.memory_item_id
         FROM memory_retrieval_shows AS show
         JOIN memory_item_refs AS ref ON ref.memory_item_id = show.claim_id
         WHERE show.conversation_id = $1 AND show.turn_id = $2
           AND ref.memory_ref = ANY($3::text[])
       )
       UPDATE memory_items AS item
       SET usage_count = item.usage_count + 1, last_used_at = now()
       FROM shown
       WHERE item.id = shown.memory_item_id AND item.claim_status = 'active'
       RETURNING shown.memory_ref`,
      [window.conversationId, window.turnId, [...memoryRefs]],
    );
    const used = updated.rows.map((row) => row.memory_ref);
    return {
      rejected: memoryRefs.filter((ref) => !used.includes(ref)),
      used,
    };
  },
};
