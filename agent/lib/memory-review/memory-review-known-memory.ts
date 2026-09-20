/**
 * What the silent review already knows before it reads its batch.
 *
 * Exports:
 * - `MemoryReviewKnownRecord`: one stored record as the review is shown it.
 * - `selectMemoryReviewContext`: the records and the already-read messages for one batch.
 *
 * The review used to receive its fifty messages and nothing else. It could not know that the fact
 * in front of it had been written down last week in other words, so it wrote it again: 865 pairs
 * of records about one subject sit at similarity 0.90 or above on 1464 indexed records, and memory
 * grew from 39 records in July to 1112 in September.
 *
 * Two blocks, and each answers a different question. The records answer «is this already known»,
 * and give the review a third option besides saving and not saving: refine what exists. The tail
 * of already-read messages answers «where does my batch begin», so a fact spread over the boundary
 * is not read as a new one.
 *
 * Both are bounded on purpose. Everything here is paid for on every batch, and a conversation that
 * has been running for a year would otherwise carry its whole memory into every prompt.
 */
import { database } from "../database.js";
import {
  MEMORY_REVIEW_KNOWN_RECORD_LIMIT,
  MEMORY_REVIEW_REVIEWED_TAIL_LIMIT,
} from "./memory-review-config.js";

export interface MemoryReviewKnownRecord {
  attribute: string | null;
  content: string;
  kind: string;
  memoryRef: string;
}

export interface MemoryReviewReviewedMessage {
  contentText: string;
  senderDisplayName: string;
  sourceSequence: string;
}

export interface MemoryReviewContext {
  known: MemoryReviewKnownRecord[];
  reviewed: MemoryReviewReviewedMessage[];
}

/**
 * The selection is the most recent memory of this conversation's own area, never a search: a batch
 * has no single question to search by, and recency is where the duplicates are — 58% of production
 * memory was written on three active days.
 */
export async function selectMemoryReviewContext(input: {
  conversationId: string;
  familyId: string;
  scope: string;
  scopePartitionKey: string;
  predecessorSequence: string;
}): Promise<MemoryReviewContext> {
  const known = await database().query<{
    attribute: string | null;
    content: string;
    kind: string;
    memory_ref: string;
  }>(
    `SELECT item.attribute, item.content, item.kind::text, ref.memory_ref
     FROM memory_items AS item
     JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
     WHERE item.family_id = $1 AND item.scope = $2::memory_scope
       AND item.scope_partition_key = $3 AND item.claim_status = 'active'
     ORDER BY item.created_at DESC, item.id DESC
     LIMIT $4`,
    [input.familyId, input.scope, input.scopePartitionKey, MEMORY_REVIEW_KNOWN_RECORD_LIMIT],
  );
  const reviewed = await database().query<{
    content_text: string;
    sender_display_name: string;
    sequence_id: string;
  }>(
    `SELECT message.content_text, message.sender_display_name, message.sequence_id::text
     FROM telegram_group_messages AS message
     JOIN application_conversations AS conversation ON conversation.id = message.conversation_id
     WHERE message.conversation_id = $1 AND conversation.family_id = $2
       AND message.content_text IS NOT NULL
       AND message.sequence_id <= $3::bigint
     ORDER BY message.sequence_id DESC
     LIMIT $4`,
    [input.conversationId, input.familyId, input.predecessorSequence, MEMORY_REVIEW_REVIEWED_TAIL_LIMIT],
  );
  return {
    known: known.rows.map((row) => ({
      attribute: row.attribute,
      content: row.content,
      kind: row.kind,
      memoryRef: row.memory_ref,
    })),
    // Chronological, because the model reads them as the run-up to its batch.
    reviewed: reviewed.rows.reverse().map((row) => ({
      contentText: row.content_text,
      senderDisplayName: row.sender_display_name,
      sourceSequence: row.sequence_id,
    })),
  };
}
