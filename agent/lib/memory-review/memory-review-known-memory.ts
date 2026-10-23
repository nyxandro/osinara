/**
 * What the silent review already knows before it reads its batch.
 *
 * Exports:
 * - `MemoryReviewKnownRecord`: one stored record as the review is shown it.
 * - `selectMemoryReviewContext`: the records, the already-read messages, the authors' property
 *   names and the conversation's discussion summaries for one batch.
 *
 * The review used to receive its fifty messages and nothing else. It could not know that the fact
 * in front of it had been written down last week in other words, so it wrote it again: 865 pairs
 * of records about one subject sit at similarity 0.90 or above on 1464 indexed records, and memory
 * grew from 39 records in July to 1112 in September.
 *
 * Four blocks, and each answers a different question. The records answer «is this already known»,
 * and give the review a third option besides saving and not saving: refine what exists. The tail
 * of already-read messages answers «where does my batch begin», so a fact spread over the boundary
 * is not read as a new one. The property names already set for the batch's authors answer «what is
 * this property called here», so a new value meets the version it replaces instead of starting a
 * second one under new words («гейминг» beside «gaming»). The topics the conversation already keeps
 * a discussion summary of answer the same question for a discussion: a batch that continues one
 * updates its summary by the same name.
 *
 * All four are bounded on purpose. Everything here is paid for on every batch, and a conversation
 * that has been running for a year would otherwise carry its whole memory into every prompt.
 *
 * All run on the caller's connection: the dispatcher holds an open transaction with row leases
 * while it builds a batch, and taking a second connection from the pool there is how a busy
 * dispatcher deadlocks itself against its own leases.
 */
import type { PoolClient } from "pg";

import { MEMORY_DISCUSSION_SUMMARY_PREFIX } from "../memory-attribute-slot.js";
import {
  MEMORY_REVIEW_AUTHOR_PROPERTY_LIMIT,
  MEMORY_REVIEW_DISCUSSION_SUMMARY_LIMIT,
  MEMORY_REVIEW_KNOWN_RECORD_LIMIT,
  MEMORY_REVIEW_REVIEWED_TAIL_LIMIT,
} from "./memory-review-config.js";

export interface MemoryReviewKnownRecord {
  /**
   * Absent rather than null when the record has no slot, as in every other model-facing record.
   * Shown `"attribute": null` on most records, the review most likely copied it into its own writes:
   * all ten production records with the slot "null" came from it, on 23.09 and 02.10.2026, within
   * two weeks after this block appeared. The raw calls are not journaled that far back, so the
   * cause is not proven.
   */
  attribute?: string;
  content: string;
  kind: string;
  memoryRef: string;
}

export interface MemoryReviewReviewedMessage {
  contentText: string;
  senderDisplayName: string;
  sourceSequence: string;
}

/** An author of the batch, named the way the batch names them, with their properties in memory. */
export interface MemoryReviewAuthorProperties {
  attributes: string[];
  senderDisplayName: string | null;
  senderUsername?: string;
}

export interface MemoryReviewContext {
  authorProperties: MemoryReviewAuthorProperties[];
  /** Slot names (`итог: <тема>`) of the conversation's current discussion summaries, newest first. */
  discussionSummaries: string[];
  known: MemoryReviewKnownRecord[];
  reviewed: MemoryReviewReviewedMessage[];
}

/**
 * The selection is the most recent memory of this conversation's own area, never a search: a batch
 * has no single question to search by, and recency is where the duplicates are — 58% of production
 * memory was written on three active days.
 */
export async function selectMemoryReviewContext(client: PoolClient, input: {
  conversationId: string;
  familyId: string;
  scope: string;
  scopePartitionKey: string;
  predecessorSequence: string;
  sourceEntryIds: readonly string[];
}): Promise<MemoryReviewContext> {
  const known = await client.query<{
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
       -- The review may only write normal records, so it is never shown a sensitive one.
       AND item.sensitivity = 'normal'
     ORDER BY item.created_at DESC, item.id DESC
     LIMIT $4`,
    [input.familyId, input.scope, input.scopePartitionKey, MEMORY_REVIEW_KNOWN_RECORD_LIMIT],
  );
  const reviewed = await client.query<{
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
  // An author is the conversation participant behind a batch message; a family member's record is
  // about their account, a group participant's about the participant.
  const authors = await client.query<{
    // Null for an author with no property set yet: such an author is left out of the block.
    attributes: string[] | null;
    sender_display_name: string | null;
    sender_username: string | null;
  }>(
    `SELECT (array_agg(message.sender_display_name ORDER BY message.sequence_id DESC))[1]
              AS sender_display_name,
            (array_agg(message.sender_username ORDER BY message.sequence_id DESC))[1]
              AS sender_username,
            (SELECT array_agg(property.attribute ORDER BY property.attribute)
             FROM (
               SELECT DISTINCT item.attribute
               FROM memory_items AS item
               WHERE item.family_id = $3 AND item.scope = $4::memory_scope
                 AND item.scope_partition_key = $5 AND item.claim_status = 'active'
                 AND item.sensitivity = 'normal' AND item.attribute IS NOT NULL
                 AND (item.subject_participant_id = participant.id OR
                      (participant.linked_user_id IS NOT NULL AND item.subject_user_id = participant.linked_user_id))
               ORDER BY item.attribute
               LIMIT $6
             ) AS property) AS attributes
     FROM telegram_group_messages AS message
     JOIN conversation_participants AS participant
       ON participant.conversation_id = message.conversation_id
      AND participant.telegram_user_id = message.telegram_user_id
     WHERE message.id = ANY($1::uuid[]) AND message.conversation_id = $2
     GROUP BY participant.id
     ORDER BY min(message.sequence_id)`,
    [input.sourceEntryIds, input.conversationId, input.familyId, input.scope,
      input.scopePartitionKey, MEMORY_REVIEW_AUTHOR_PROPERTY_LIMIT],
  );
  // A summary is about no one and outside any thread's project, so its slot is the topic within the
  // whole area; one with a subject or a project is not a summary a new version could replace.
  const summaries = await client.query<{ attribute: string }>(
    `SELECT item.attribute
     FROM memory_items AS item
     WHERE item.family_id = $1 AND item.scope = $2::memory_scope
       AND item.scope_partition_key = $3 AND item.claim_status = 'active'
       AND item.sensitivity = 'normal'
       AND left(item.attribute, length($4)) = $4
       AND item.subject_user_id IS NULL AND item.subject_participant_id IS NULL
       AND item.subject_conversation_id IS NULL AND item.subject_family_id IS NULL
       AND item.subject_label IS NULL AND item.memory_project_id IS NULL
     GROUP BY item.attribute
     ORDER BY max(item.created_at) DESC, item.attribute
     LIMIT $5`,
    [input.familyId, input.scope, input.scopePartitionKey, MEMORY_DISCUSSION_SUMMARY_PREFIX,
      MEMORY_REVIEW_DISCUSSION_SUMMARY_LIMIT],
  );
  return {
    authorProperties: authors.rows.flatMap((row) => row.attributes === null ? [] : [{
      attributes: row.attributes,
      senderDisplayName: row.sender_display_name,
      ...(row.sender_username === null ? {} : { senderUsername: row.sender_username }),
    }]),
    discussionSummaries: summaries.rows.map((row) => row.attribute),
    known: known.rows.map((row) => ({
      ...(row.attribute === null ? {} : { attribute: row.attribute }),
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
