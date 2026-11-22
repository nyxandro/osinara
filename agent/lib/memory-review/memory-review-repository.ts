/**
 * Durable PostgreSQL lifecycle for group memory-review lanes and batches.
 *
 * Exports:
 * - `MemoryReviewBatchSummary`: newly created background source range.
 * - `MemoryReviewClaim`: fully authorized leased batch ready for its internal turn.
 * - `memoryReviewRepository`: lane initialization, batching, leasing, and terminal transitions.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { TelegramGroupJournalEntry } from "../telegram-group-journal-context.js";
import { MEMORY_REVIEW_BATCH_SIZE } from "./memory-review-config.js";
import { memoryReviewTerminalRepository } from "./memory-review-terminal-repository.js";

export interface MemoryReviewBatchSummary {
  batchId: string;
  entries: TelegramGroupJournalEntry[];
  messageThreadId: string | null;
  sourceCount: number;
  sourceEntryIds: string[];
  status: "pending";
  throughSequence: string;
}

export interface MemoryReviewClaim extends MemoryReviewBatchSummary {
  conversationId: string;
  familyId: string;
  groupId: string;
  groupType: "external" | "family_private";
  leaseToken: string;
  ownerTelegramUserId: string;
  ownerUserId: string;
  prompt: string;
  scope: "family" | "group";
  telegramChatId: string;
  telegramChatType: "group" | "supergroup";
  toolAllowlist: string[];
}

interface LaneRow {
  conversation_id: string;
  id: string;
  message_thread_id: string | null;
  processed_through_sequence: string;
}

interface SourceRow {
  actor_id: string;
  actor_kind: "telegram_bot" | "user";
  content_text: string | null;
  id: string;
  message_kind: string;
  message_thread_id: string | null;
  reply_to_sequence_id: string | null;
  sender_display_name: string | null;
  sender_username: string | null;
  sent_at: Date;
  sequence_id: string;
}

const SOURCE_COLUMNS = `message.id, message.sequence_id::text, message.actor_kind,
  message.actor_id, message.message_thread_id::text, message.sender_username,
  message.sender_display_name, message.message_kind, message.content_text,
  message.reply_to_sequence_id::text, message.sent_at`;

function projectSource(row: SourceRow): TelegramGroupJournalEntry {
  return {
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    contentText: row.content_text,
    entryId: row.id,
    messageKind: row.message_kind,
    messageThreadId: row.message_thread_id,
    replyToSequenceId: row.reply_to_sequence_id,
    senderDisplayName: row.sender_display_name,
    senderUsername: row.sender_username,
    sentAt: row.sent_at.toISOString(),
    sequenceId: row.sequence_id,
  };
}

async function lockConversation(client: PoolClient, conversationId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [conversationId]);
}

async function laneForUpdate(
  client: PoolClient,
  conversationId: string,
  messageThreadId: string | null,
  initialSequence: string,
): Promise<LaneRow> {
  await client.query(
    `INSERT INTO memory_review_lanes
       (conversation_id, message_thread_id, processed_through_sequence)
     VALUES ($1, $2, $3)
     ON CONFLICT (conversation_id, message_thread_id) DO NOTHING`,
    [conversationId, messageThreadId, initialSequence],
  );
  const result = await client.query<LaneRow>(
    `SELECT id, conversation_id, message_thread_id::text, processed_through_sequence::text
       FROM memory_review_lanes
      WHERE conversation_id = $1 AND message_thread_id IS NOT DISTINCT FROM $2::bigint
      FOR UPDATE`,
    [conversationId, messageThreadId],
  );
  return result.rows[0]!;
}

async function coveredThrough(client: PoolClient, lane: LaneRow): Promise<string> {
  const result = await client.query<{ through_sequence: string | null }>(
    `WITH RECURSIVE chain AS (
       SELECT batch.through_sequence
         FROM memory_review_batches AS batch
        WHERE batch.lane_id = $1 AND batch.predecessor_sequence = $2
          AND batch.status NOT IN ('failed', 'ambiguous')
       UNION ALL
       SELECT next_batch.through_sequence
         FROM memory_review_batches AS next_batch
         JOIN chain ON next_batch.predecessor_sequence = chain.through_sequence
        WHERE next_batch.lane_id = $1 AND next_batch.status NOT IN ('failed', 'ambiguous')
     ) SELECT max(through_sequence)::text AS through_sequence FROM chain`,
    [lane.id, lane.processed_through_sequence],
  );
  return result.rows[0]?.through_sequence ?? lane.processed_through_sequence;
}

async function laneBlocked(client: PoolClient, lane: LaneRow): Promise<boolean> {
  const result = await client.query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM memory_review_batches
        WHERE lane_id = $1 AND predecessor_sequence = $2
          AND status IN ('failed', 'ambiguous')
     ) AS blocked`,
    [lane.id, lane.processed_through_sequence],
  );
  return result.rows[0]?.blocked === true;
}

async function sourceRows(
  client: PoolClient,
  input: {
    conversationId: string;
    limit: number | null;
    messageThreadId: string | null;
    throughSequence: string;
    upperSequence: string;
  },
): Promise<SourceRow[]> {
  const result = await client.query<SourceRow>(
    `SELECT ${SOURCE_COLUMNS}
       FROM telegram_group_messages AS message
      WHERE message.conversation_id = $1 AND message.actor_kind IN ('user', 'telegram_bot')
        AND message.message_thread_id IS NOT DISTINCT FROM $2::bigint
        AND message.sequence_id > $3::bigint AND message.sequence_id <= $4::bigint
      ORDER BY message.sequence_id
      LIMIT $5`,
    [input.conversationId, input.messageThreadId, input.throughSequence,
      input.upperSequence, input.limit],
  );
  return result.rows;
}

async function insertBatch(
  client: PoolClient,
  input: {
    lane: LaneRow;
    predecessorSequence: string;
    sources: readonly SourceRow[];
  },
): Promise<MemoryReviewBatchSummary> {
  const first = input.sources[0];
  const last = input.sources.at(-1);
  if (!first || !last) {
    throw new AppError(
      "AGENT_MEMORY_REVIEW_SOURCE_SET_EMPTY",
      "Для проверки памяти не найдено сообщений",
    );
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO memory_review_batches
       (lane_id, conversation_id, batch_kind, status, predecessor_sequence,
         from_sequence, through_sequence, source_count)
     VALUES ($1, $2, 'background', 'pending', $3, $4, $5, $6)
     RETURNING id`,
    [input.lane.id, input.lane.conversation_id, input.predecessorSequence,
      first.sequence_id, last.sequence_id, input.sources.length],
  );
  const batchId = inserted.rows[0]!.id;
  await client.query(
    `INSERT INTO memory_review_batch_sources
       (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
     SELECT $1, $2, source.id, source.sequence_id
       FROM unnest($3::uuid[], $4::bigint[]) AS source(id, sequence_id)`,
    [batchId, input.lane.conversation_id, input.sources.map((source) => source.id),
      input.sources.map((source) => source.sequence_id)],
  );
  return {
    batchId,
    entries: input.sources.map(projectSource),
    messageThreadId: input.lane.message_thread_id,
    sourceCount: input.sources.length,
    sourceEntryIds: input.sources.map((source) => source.id),
    status: "pending",
    throughSequence: last.sequence_id,
  };
}

export const memoryReviewRepository = {
  ...memoryReviewTerminalRepository,
  async initializeLane(input: {
    conversationId: string;
    messageThreadId: string | null;
    processedThroughSequence: string;
  }): Promise<void> {
    await database().query(
      `INSERT INTO memory_review_lanes
         (conversation_id, message_thread_id, processed_through_sequence)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, message_thread_id) DO NOTHING`,
      [input.conversationId, input.messageThreadId, input.processedThroughSequence],
    );
  },

  /**
   * Every group message joins its lane's review queue, addressed or not (#569): this opens the lane
   * of a new chat or topic and cuts a batch the moment 50 messages wait. The dispatcher sees only
   * lanes that exist, so a message never observed would never be reviewed.
   */
  async observeGroupMessage(input: {
    groupId: string;
    timelineEntryId: string;
  }): Promise<MemoryReviewBatchSummary | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const message = await client.query<{
        actor_kind: TelegramGroupJournalEntry["actorKind"];
        conversation_id: string;
        message_thread_id: string | null;
        sequence_id: string;
      }>(
        `SELECT conversation_id, message_thread_id::text, sequence_id::text, actor_kind
           FROM telegram_group_messages
          WHERE id = $1 AND group_id = $2 FOR SHARE`,
        [input.timelineEntryId, input.groupId],
      );
      const source = message.rows[0];
      if (!source || (source.actor_kind !== "user" && source.actor_kind !== "telegram_bot")) {
        await client.query("COMMIT");
        return null;
      }
      await lockConversation(client, source.conversation_id);
      const lane = await laneForUpdate(
        client,
        source.conversation_id,
        source.message_thread_id,
        "0",
      );
      if (await laneBlocked(client, lane)) {
        await client.query("COMMIT");
        return null;
      }
      const predecessor = await coveredThrough(client, lane);
      const sources = await sourceRows(client, {
        conversationId: source.conversation_id,
        limit: MEMORY_REVIEW_BATCH_SIZE,
        messageThreadId: source.message_thread_id,
        throughSequence: predecessor,
        upperSequence: source.sequence_id,
      });
      if (sources.length < MEMORY_REVIEW_BATCH_SIZE) {
        await client.query("COMMIT");
        return null;
      }
      const batch = await insertBatch(client, {
        lane,
        predecessorSequence: predecessor,
        sources,
      });
      await client.query("COMMIT");
      return batch;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async getLaneCursor(input: {
    conversationId: string;
    messageThreadId: string | null;
  }): Promise<string | null> {
    const result = await database().query<{ processed_through_sequence: string }>(
      `SELECT processed_through_sequence::text FROM memory_review_lanes
        WHERE conversation_id = $1 AND message_thread_id IS NOT DISTINCT FROM $2::bigint`,
      [input.conversationId, input.messageThreadId],
    );
    return result.rows[0]?.processed_through_sequence ?? null;
  },

  async bindAgentTurn(input: {
    applicationSessionId: string;
    batchId: string;
    agentSessionId: string;
    agentTurnId: string;
  }): Promise<void> {
    const result = await database().query(
      `UPDATE memory_review_batches
          SET status = 'running', agent_session_id = $2, agent_turn_id = $3,
              started_at = coalesce(started_at, now()), updated_at = now(),
              lease_token = NULL, lease_expires_at = NULL
        WHERE id = $1 AND status IN ('dispatching', 'running')
          AND application_session_id = $4
          AND (agent_session_id IS NULL OR agent_session_id = $2)
          AND (agent_turn_id IS NULL OR agent_turn_id = $3)`,
      [input.batchId, input.agentSessionId, input.agentTurnId, input.applicationSessionId],
    );
    if (result.rowCount !== 1) throw new AppError(
      "AGENT_MEMORY_REVIEW_TURN_BINDING_INVALID",
      "Не удалось связать проверку памяти с текущим ходом",
    );
  },

};
