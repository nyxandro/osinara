/**
 * Shared PostgreSQL fixtures for group memory-review integration tests.
 *
 * Exports:
 * - `insertReviewUserMessage`: one passive user message on a group timeline.
 * - `insertReviewSession`: one canonical group session that can own a review turn.
 * - `insertHistoricalInteractiveBatch`, `bindHistoricalInteractiveTurn`: a chat turn's review batch
 *   as the retired path (before #569) left it, for tests of the paths that still settle it.
 */
import { database } from "../database.js";

export async function insertReviewUserMessage(input: {
  conversationId: string;
  groupId: string | null;
  messageThreadId?: number;
  sequence: number;
}): Promise<{ id: string }> {
  return (await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text,
        message_thread_id, sent_at)
     VALUES ($1, $2, $3, $3, 'user', 'telegram:agent-memory-author',
             'agent-memory-author', 'Анна', false, 'text', $4, $5, now())
     RETURNING id`,
    [input.conversationId, input.groupId, input.sequence,
      `Сообщение памяти ${input.sequence}`, input.messageThreadId ?? null],
  )).rows[0]!;
}

export async function insertReviewSession(
  familyId: string,
  groupId: string,
  conversationKey: string,
): Promise<string> {
  return (await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
        continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', $3, $3, now(), now())
     RETURNING id`,
    [familyId, groupId, conversationKey],
  )).rows[0]!.id;
}

export interface HistoricalInteractiveBatch {
  batchId: string;
  sourceCount: number;
  sourceEntryIds: string[];
  throughSequence: string;
}

/**
 * A `running` interactive batch as the retired chat-turn path left it (before #569). Such rows stay
 * in the table until settled, and the generic terminal and abandoned-turn paths still settle them.
 * Like that path, it covers every unreviewed message of the lane up to `timelineEntryId`, behind
 * any live batch already standing on the lane.
 */
export async function insertHistoricalInteractiveBatch(input: {
  applicationSessionId: string;
  groupId: string;
  timelineEntryId: string;
}): Promise<HistoricalInteractiveBatch> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query<{
      conversation_id: string; message_thread_id: string | null; sequence_id: string;
    }>(
      `SELECT conversation_id, message_thread_id::text, sequence_id::text FROM telegram_group_messages
        WHERE id = $1 AND group_id = $2`,
      [input.timelineEntryId, input.groupId],
    )).rows[0]!;
    await client.query(
      `INSERT INTO memory_review_lanes (conversation_id, message_thread_id, processed_through_sequence)
       VALUES ($1, $2, 0) ON CONFLICT (conversation_id, message_thread_id) DO NOTHING`,
      [current.conversation_id, current.message_thread_id],
    );
    const lane = (await client.query<{ id: string; processed_through_sequence: string }>(
      `SELECT id, processed_through_sequence::text FROM memory_review_lanes
        WHERE conversation_id = $1 AND message_thread_id IS NOT DISTINCT FROM $2::bigint`,
      [current.conversation_id, current.message_thread_id],
    )).rows[0]!;
    const covered = (await client.query<{ through: string | null }>(
      `SELECT max(through_sequence)::text AS through FROM memory_review_batches
        WHERE lane_id = $1 AND through_sequence > $2 AND status NOT IN ('failed', 'ambiguous')`,
      [lane.id, lane.processed_through_sequence],
    )).rows[0]!.through ?? lane.processed_through_sequence;
    const sources = (await client.query<{ id: string; sequence_id: string }>(
      `SELECT id, sequence_id::text FROM telegram_group_messages
        WHERE conversation_id = $1 AND message_thread_id IS NOT DISTINCT FROM $2::bigint
          AND actor_kind IN ('user', 'telegram_bot') AND sequence_id > $3 AND sequence_id <= $4
        ORDER BY sequence_id`,
      [current.conversation_id, current.message_thread_id, covered, current.sequence_id],
    )).rows;
    const throughSequence = sources.at(-1)!.sequence_id;
    const batchId = (await client.query<{ id: string }>(
      `INSERT INTO memory_review_batches
         (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
          through_sequence, source_count, application_session_id, started_at, preparation_entry_id)
       VALUES ($1, $2, 'interactive', 'running', $3, $4, $5, $6, $7, now(), $8) RETURNING id`,
      [lane.id, current.conversation_id, covered, sources[0]!.sequence_id, throughSequence,
        sources.length, input.applicationSessionId, input.timelineEntryId],
    )).rows[0]!.id;
    await client.query(
      `INSERT INTO memory_review_batch_sources (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
       SELECT $1, $2, source.id, source.sequence_id
         FROM unnest($3::uuid[], $4::bigint[]) AS source(id, sequence_id)`,
      [batchId, current.conversation_id, sources.map((source) => source.id),
        sources.map((source) => source.sequence_id)],
    );
    await client.query("COMMIT");
    return { batchId, sourceCount: sources.length, sourceEntryIds: sources.map((source) => source.id), throughSequence };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The source set a chat turn bound to its interactive batch at `turn.started`, before #569. */
export async function bindHistoricalInteractiveTurn(input: {
  agentSessionId: string;
  agentTurnId: string;
  applicationSessionId: string;
  batch: HistoricalInteractiveBatch;
  conversationId: string;
  currentTimelineEntryId: string;
}): Promise<void> {
  await database().query(
    `INSERT INTO memory_turn_source_sets
       (agent_session_id, agent_turn_id, application_session_id, conversation_id,
        current_timeline_entry_id, invoking_actor_kind, invoking_actor_id, binding_hash,
        memory_review_batch_id)
     VALUES ($1, $2, $3, $4, $5, 'telegram_user', 'agent-memory-author', $6, $7)`,
    [input.agentSessionId, input.agentTurnId, input.applicationSessionId, input.conversationId,
      input.currentTimelineEntryId, "a".repeat(64), input.batch.batchId],
  );
  await database().query(
    `INSERT INTO memory_turn_sources
       (agent_session_id, agent_turn_id, conversation_id, timeline_entry_id, timeline_sequence, is_current)
     SELECT $1, $2, source.conversation_id, source.timeline_entry_id, source.timeline_sequence,
            source.timeline_entry_id = $4
       FROM memory_review_batch_sources AS source WHERE source.batch_id = $3`,
    [input.agentSessionId, input.agentTurnId, input.batch.batchId, input.currentTimelineEntryId],
  );
}
