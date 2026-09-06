/**
 * Durable group memory-review PostgreSQL integration tests.
 *
 * Constructs covered:
 * - Passive user messages form one immutable batch when one lane reaches 50 sources; personal lanes are claimable.
 * - Agent responses and other forum topics do not count toward that lane's batch.
 * - Active source rows prevent timeline pruning until terminal completion.
 * - Successful review advances the lane cursor; failure leaves the lane blocked at its predecessor.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  createMainAgentMemoryFixture,
  createMainAgentPrivateMemoryFixture,
} from "../memory-agent-write.integration-fixtures.js";
import { memoryTurnSourceRepository } from "../memory-turn-source-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

async function insertUserMessage(input: {
  conversationId: string;
  groupId: string | null;
  messageThreadId?: number;
  sequence: number;
}) {
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

/** Eight passive messages: the shortest tail an addressed turn still reviews inline. */
async function insertInteractiveTail(input: { conversationId: string; groupId: string }) {
  let last: { id: string } | null = null;
  for (let sequence = 2; sequence <= 9; sequence += 1) {
    last = await insertUserMessage({ ...input, sequence });
  }
  return last!;
}

describeWithDatabase("memory review repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("creates one pending batch after exactly 50 passive user messages in one topic", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: "42",
      processedThroughSequence: "1",
    });

    let created = null;
    for (let sequence = 2; sequence <= 51; sequence += 1) {
      const message = await insertUserMessage({
        conversationId: fixture.conversationId,
        groupId: fixture.groupId,
        messageThreadId: 42,
        sequence,
      });
      created = await memoryReviewRepository.observePassiveMessage({
        groupId: fixture.groupId,
        timelineEntryId: message.id,
      });
      if (sequence < 51) expect(created).toBeNull();
    }

    expect(created).toMatchObject({
      messageThreadId: "42",
      sourceCount: 50,
      status: "pending",
      throughSequence: "51",
    });
    await expect(database().query(
      "SELECT count(*)::integer AS count FROM memory_review_batch_sources WHERE batch_id = $1",
      [created!.batchId],
    )).resolves.toMatchObject({ rows: [{ count: 50 }] });
  });

  it("does not count agent output or another forum topic toward a lane", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    await database().query(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 2, 2, 'agent_self', 'agent:osinara', 'Осинара', true,
               'text', 'Ответ агента', now())`,
      [fixture.conversationId, fixture.groupId],
    );
    const otherTopic = await insertUserMessage({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
      messageThreadId: 42,
      sequence: 3,
    });

    await expect(memoryReviewRepository.observePassiveMessage({
      groupId: fixture.groupId,
      timelineEntryId: otherTopic.id,
    })).resolves.toBeNull();
    await expect(database().query(
      "SELECT count(*)::integer AS count FROM memory_review_batches",
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("materializes a committed 50-message gap before leasing after observer crash", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await database().query(
      "UPDATE telegram_groups SET telegram_chat_type = 'supergroup' WHERE id = $1",
      [fixture.groupId],
    );
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    for (let sequence = 2; sequence <= 51; sequence += 1) {
      await insertUserMessage({
        conversationId: fixture.conversationId,
        groupId: fixture.groupId,
        sequence,
      });
    }

    const claimed = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-08-12T10:00:00.000Z"),
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      sourceCount: 50,
      status: "pending",
      throughSequence: "51",
    });
  });

  it("materializes and claims a personal lane batch once fifty sources accumulate", async () => {
    const fixture = await createMainAgentPrivateMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    for (let sequence = 2; sequence <= 51; sequence += 1) {
      await insertUserMessage({
        conversationId: fixture.conversationId,
        groupId: null,
        sequence,
      });
    }

    const claimed = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-08-12T10:00:00.000Z"),
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      groupId: null,
      scope: "personal",
      sourceCount: 50,
      telegramChatType: "private",
      throughSequence: "51",
    });
  });

  it("retains active sources and advances only after successful completion", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    const session = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'review-interactive',
               'review-interactive', now(), now()) RETURNING id`,
      [fixture.familyId, fixture.groupId],
    );
    const firstSource = await insertInteractiveTail({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
    });
    const first = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session.rows[0]!.id,
      groupId: fixture.groupId,
      timelineEntryId: firstSource.id,
    });
    expect(first?.sourceEntryIds).toHaveLength(8);
    expect(first?.sourceEntryIds.at(-1)).toBe(firstSource.id);

    await expect(database().query(
      "DELETE FROM telegram_group_messages WHERE id = $1",
      [firstSource.id],
    )).rejects.toThrow();

    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session.rows[0]!.id,
      batchId: first!.batchId,
      eveSessionId: "eve-retention-complete",
      eveTurnId: "turn-retention-complete",
    });
    await memoryTurnSourceRepository.bind({
      applicationSessionId: session.rows[0]!.id,
      conversationId: fixture.conversationId,
      currentTimelineEntryId: firstSource.id,
      eveSessionId: "eve-retention-complete",
      eveTurnId: "turn-retention-complete",
      invokingActorId: "agent-memory-author",
      invokingActorKind: "telegram_user",
      memoryReviewBatchId: first!.batchId,
      memoryReviewSourceEntryIds: first!.sourceEntryIds,
      visibleTimelineEntryIds: first!.sourceEntryIds,
    });
    await memoryReviewRepository.completeBatch({
      batchId: first!.batchId,
      completedAt: new Date(),
      eveSessionId: "eve-retention-complete",
      eveTurnId: "turn-retention-complete",
    });
    await memoryTurnSourceRepository.release("eve-retention-complete", "turn-retention-complete");
    await expect(memoryReviewRepository.getLaneCursor({
      conversationId: fixture.conversationId,
      messageThreadId: null,
    })).resolves.toBe("9");
    await expect(database().query(
      "DELETE FROM telegram_group_messages WHERE id = $1",
      [firstSource.id],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("leaves a tail shorter than eight messages to idle review", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'review-short-tail',
               'review-short-tail', now(), now()) RETURNING id`,
      [fixture.familyId, fixture.groupId],
    );
    let source: { id: string } | null = null;
    for (const sequence of [2, 3]) {
      source = await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId, sequence,
      });
    }

    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session.rows[0]!.id,
      groupId: fixture.groupId,
      timelineEntryId: source!.id,
    });

    expect(batch).toBeNull();
    await expect(database().query(
      "SELECT count(*)::text AS count FROM memory_review_batches WHERE conversation_id = $1",
      [fixture.conversationId],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("accepts replayed terminal events without changing the recorded outcome", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'review-replay',
               'review-replay', now(), now()) RETURNING id`,
      [fixture.familyId, fixture.groupId],
    );
    const source = await insertInteractiveTail({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
    });
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session.rows[0]!.id,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });

    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session.rows[0]!.id,
      batchId: batch!.batchId,
      eveSessionId: "eve-review-replay",
      eveTurnId: "turn-review-replay",
    });
    await memoryTurnSourceRepository.bind({
      applicationSessionId: session.rows[0]!.id,
      conversationId: fixture.conversationId,
      currentTimelineEntryId: source.id,
      eveSessionId: "eve-review-replay",
      eveTurnId: "turn-review-replay",
      invokingActorId: "agent-memory-author",
      invokingActorKind: "telegram_user",
      memoryReviewBatchId: batch!.batchId,
      memoryReviewSourceEntryIds: batch!.sourceEntryIds,
      visibleTimelineEntryIds: batch!.sourceEntryIds,
    });
    const completion = {
      batchId: batch!.batchId,
      completedAt: new Date(),
      eveSessionId: "eve-review-replay",
      eveTurnId: "turn-review-replay",
    };
    await expect(memoryReviewRepository.completeBatch(completion))
      .resolves.toBe("recorded");
    await expect(memoryReviewRepository.completeBatch(completion))
      .resolves.toBe("replayed");
    await expect(database().query(
      "SELECT completed_turns FROM conversation_sessions WHERE id = $1",
      [session.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ completed_turns: 1 }] });
    await expect(memoryReviewRepository.failRunning({
      batchId: batch!.batchId,
      diagnosticCode: "AGENT_MEMORY_REVIEW_REPLAYED_FAILURE",
      eveSessionId: "eve-review-replay",
      eveTurnId: "turn_0",
    })).rejects.toThrowError(/AGENT_MEMORY_REVIEW_FAILURE_STATE_INVALID/u);
  });

  it("accepts an exact replay of a failed terminal event", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'review-failure-replay',
               'review-failure-replay', now(), now()) RETURNING id`,
      [fixture.familyId, fixture.groupId],
    );
    const source = await insertInteractiveTail({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
    });
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session.rows[0]!.id,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session.rows[0]!.id,
      batchId: batch!.batchId,
      eveSessionId: "eve-review-failure-replay",
      eveTurnId: "turn-review-failure-replay",
    });
    const failure = {
      batchId: batch!.batchId,
      diagnosticCode: "AGENT_MEMORY_REVIEW_MODEL_FAILED",
      eveSessionId: "eve-review-failure-replay",
      eveTurnId: "turn-review-failure-replay",
    };

    // Ход ничего не записал, поэтому батч освобождается, а повтор события идемпотентен.
    await expect(memoryReviewRepository.failRunning(failure)).resolves.toBe("released");
    await expect(memoryReviewRepository.failRunning(failure)).resolves.toBe("replayed");
    await expect(database().query(
      "SELECT completed_turns FROM conversation_sessions WHERE id = $1",
      [session.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ completed_turns: 0 }] });
  });

  it("counts a failed turn that already wrote memory and moves the lane on", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'review-failure-wrote',
               'review-failure-wrote', now(), now()) RETURNING id`,
      [fixture.familyId, fixture.groupId],
    );
    const source = await insertInteractiveTail({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
    });
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session.rows[0]!.id,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session.rows[0]!.id,
      batchId: batch!.batchId,
      eveSessionId: "eve-review-wrote",
      eveTurnId: "turn-review-wrote",
    });
    await database().query(
      `INSERT INTO memory_items_all
         (family_id, scope, kind, confirmation, sensitivity, content, source, operation_key)
       VALUES ($1, 'family', 'fact', 'model_high', 'normal', 'Записано до сбоя', $2, $3)`,
      [fixture.familyId, "eve:eve-review-wrote:turn-review-wrote", "op-review-wrote"],
    );

    // Повтор такого хода создал бы дубликат, поэтому проход засчитывается. Прежний терминал
    // `failed` был честнее по смыслу, но занимал место на курсоре и глушил лейн навсегда.
    await expect(memoryReviewRepository.failRunning({
      batchId: batch!.batchId,
      diagnosticCode: "AGENT_MEMORY_REVIEW_MODEL_FAILED",
      eveSessionId: "eve-review-wrote",
      eveTurnId: "turn-review-wrote",
    })).resolves.toBe("recorded");
    await expect(database().query(
      `SELECT batch.status::text, batch.diagnostic_code,
              lane.processed_through_sequence::text AS cursor
         FROM memory_review_batches AS batch
         JOIN memory_review_lanes AS lane ON lane.id = batch.lane_id
        WHERE batch.id = $1`,
      [batch!.batchId],
    )).resolves.toMatchObject({
      rows: [{
        cursor: "9",
        diagnostic_code: "AGENT_MEMORY_REVIEW_MODEL_FAILED",
        status: "completed",
      }],
    });
  });

  it("releases an interactive batch that never reached an Eve turn", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'review-stale',
               'review-stale', now(), now()) RETURNING id`,
      [fixture.familyId, fixture.groupId],
    );
    const source = await insertInteractiveTail({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
    });
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session.rows[0]!.id,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await database().query(
      `UPDATE memory_review_batches
          SET started_at = '2026-08-12T09:00:00.000Z', updated_at = '2026-08-12T09:00:00.000Z'
        WHERE id = $1`,
      [batch!.batchId],
    );

    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-08-12T10:00:00.000Z"),
    });

    // Без привязки к ходу пакет доказуемо ничего не записал: ждать нечего, а прежний терминал
    // `ambiguous` держал курсор занятым навсегда и в проде останавливал проверку целой группы.
    await expect(database().query(
      "SELECT count(*)::integer AS batches FROM memory_review_batches WHERE id = $1",
      [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{ batches: 0 }] });
    // Источники вернулись в непроверенный хвост, и владельца незачем беспокоить.
    const repeated = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session.rows[0]!.id,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    expect(repeated?.sourceCount).toBe(9);
    await expect(database().query(
      "SELECT count(*)::integer AS alerts FROM memory_review_owner_alerts",
    )).resolves.toMatchObject({ rows: [{ alerts: 0 }] });
  });

});
