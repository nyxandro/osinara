/**
 * Age-based memory-review batch release PostgreSQL integration tests.
 *
 * Constructs covered:
 * - Short batch released once its oldest source outwaits the age limit, and its schema marker.
 * - Refusal below the limit, on an empty lane, and on a lane whose head is already occupied.
 * - Repeated release across dispatcher cycles, so a quiet lane never flushes only once.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { MEMORY_REVIEW_BATCH_MAX_AGE_MILLISECONDS } from "./memory-review-config.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { memoryReviewSessionRepository } from "./memory-review-session-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

const NOW = new Date("2026-08-12T10:00:00.000Z");

function beforeNow(milliseconds: number): Date {
  return new Date(NOW.getTime() - milliseconds);
}

const OUTWAITED = beforeNow(MEMORY_REVIEW_BATCH_MAX_AGE_MILLISECONDS + 60_000);
const STILL_WAITING = beforeNow(MEMORY_REVIEW_BATCH_MAX_AGE_MILLISECONDS - 60_000);

async function claimPending(now: Date) {
  return memoryReviewDispatchRepository.claimPending({ leaseMilliseconds: 60_000, limit: 10, now });
}

async function batchRows() {
  return (await database().query<{ aged_release_at: Date | null; source_count: number }>(
    "SELECT aged_release_at, source_count FROM memory_review_batches ORDER BY created_at",
  )).rows;
}

async function appendMessage(input: {
  conversationId: string;
  groupId: string;
  sentAt: Date;
  sequence: number;
}) {
  const source = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, $3, $3, 'user', 'telegram:agent-memory-author', 'agent-memory-author',
             'Анна', false, 'text', $4, $5) RETURNING id`,
    [input.conversationId, input.groupId, input.sequence,
      `Сообщение памяти ${input.sequence}`, input.sentAt],
  );
  return source.rows[0]!;
}

/**
 * The fixture seeds its own message at sequence 1 by the wall clock. Every test here freezes
 * `now`, so that timestamp is restated too: otherwise the backlog age would depend on the
 * calendar rather than on what the test declares.
 */
async function seedLane(input: { count: number; seedSentAt: Date; sentAt: Date }) {
  const fixture = await createMainAgentMemoryFixture();
  await database().query(
    "UPDATE telegram_group_messages SET sent_at = $2 WHERE conversation_id = $1",
    [fixture.conversationId, input.seedSentAt],
  );
  for (let sequence = 2; sequence < 2 + input.count; sequence += 1) {
    const source = await appendMessage({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
      sentAt: input.sentAt,
      sequence,
    });
    await memoryReviewRepository.observePassiveMessage({
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
  }
  return fixture;
}

describeWithDatabase("memory review aged release", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("выпускает короткий пакет, когда самое старое сообщение пережидало порог", async () => {
    // Свежее сообщение входит в тот же пакет: сбрасывается весь ждущий хвост, а не его просроченная часть.
    const fixture = await seedLane({ count: 2, seedSentAt: OUTWAITED, sentAt: beforeNow(60_000) });
    const claims = await claimPending(NOW);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      conversationId: fixture.conversationId,
      sourceCount: 3,
      status: "pending",
    });
    await expect(batchRows()).resolves.toEqual([{ aged_release_at: NOW, source_count: 3 }]);
  });

  it("не выпускает пакет, пока порог по времени не наступил", async () => {
    await seedLane({ count: 2, seedSentAt: STILL_WAITING, sentAt: STILL_WAITING });
    await expect(claimPending(NOW)).resolves.toHaveLength(0);
    await expect(batchRows()).resolves.toEqual([]);
  });

  it("выпускает ровно в момент порога, не позже", async () => {
    const sentAt = beforeNow(MEMORY_REVIEW_BATCH_MAX_AGE_MILLISECONDS);
    await seedLane({ count: 1, seedSentAt: sentAt, sentAt });
    await expect(claimPending(new Date(NOW.getTime() - 1_000))).resolves.toHaveLength(0);
    await expect(claimPending(NOW)).resolves.toHaveLength(1);
  });

  it("не помечает просроченный полный пакет как выпущенный по возрасту", async () => {
    // Порог по размеру наступает первым, поэтому возраст в решении не участвует и метки быть не должно.
    await seedLane({ count: 49, seedSentAt: OUTWAITED, sentAt: OUTWAITED });
    const claims = await claimPending(NOW);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.sourceCount).toBe(50);
    await expect(batchRows()).resolves.toEqual([{ aged_release_at: null, source_count: 50 }]);
  });

  it("не трогает дорожку без непроверенных сообщений", async () => {
    const fixture = await seedLane({ count: 1, seedSentAt: OUTWAITED, sentAt: OUTWAITED });
    await database().query(
      "UPDATE memory_review_lanes SET processed_through_sequence = 2 WHERE conversation_id = $1",
      [fixture.conversationId],
    );
    await expect(claimPending(NOW)).resolves.toHaveLength(0);
    await expect(batchRows()).resolves.toEqual([]);
  });

  it("не выпускает просроченный хвост, пока голова дорожки занята остановленным пакетом", async () => {
    // Новый класс отказа: тихая дорожка теперь доходит до головы, а остановленный пакет её держит.
    const fixture = await seedLane({ count: 49, seedSentAt: OUTWAITED, sentAt: OUTWAITED });
    const [claim] = await claimPending(NOW);
    const session = await memoryReviewSessionRepository.prepare(claim!, NOW);
    await memoryReviewDispatchRepository.markAmbiguous(
      claim!,
      "AGENT_MEMORY_REVIEW_TEST_AMBIGUOUS",
      session.id,
    );
    const source = await appendMessage({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
      sentAt: OUTWAITED,
      sequence: 51,
    });
    await memoryReviewRepository.observePassiveMessage({
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await expect(claimPending(new Date(NOW.getTime() + 60_000))).resolves.toHaveLength(0);
    await expect(batchRows()).resolves.toHaveLength(1);
  });

  it("продолжает выпускать хвост следующими циклами, а не один раз", async () => {
    const fixture = await seedLane({ count: 1, seedSentAt: OUTWAITED, sentAt: OUTWAITED });
    await expect(claimPending(NOW)).resolves.toHaveLength(1);
    // Курсор двигает завершение хода; здесь оно заменено прямой правкой, чтобы проверять
    // только повторяемость выпуска, а не уже покрытую механику завершения.
    await database().query(
      "UPDATE memory_review_lanes SET processed_through_sequence = 2 WHERE conversation_id = $1",
      [fixture.conversationId],
    );
    const source = await appendMessage({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
      sentAt: OUTWAITED,
      sequence: 3,
    });
    await memoryReviewRepository.observePassiveMessage({
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    const second = await claimPending(new Date(NOW.getTime() + 60_000));
    expect(second).toHaveLength(1);
    expect(second[0]!.sourceCount).toBe(1);
    await expect(batchRows()).resolves.toEqual([
      { aged_release_at: NOW, source_count: 2 },
      { aged_release_at: new Date(NOW.getTime() + 60_000), source_count: 1 },
    ]);
  });

  it("схема не принимает метку возраста у интерактивного пакета", async () => {
    await seedLane({ count: 1, seedSentAt: OUTWAITED, sentAt: OUTWAITED });
    await claimPending(NOW);
    await expect(database().query(
      `UPDATE memory_review_batches
          SET batch_kind = 'interactive', status = 'ambiguous',
              diagnostic_code = 'AGENT_MEMORY_REVIEW_TEST_AMBIGUOUS', completed_at = now(),
              lease_token = NULL, lease_expires_at = NULL`,
    )).rejects.toThrow(/memory_review_batches_aged_release_kind/u);
  });
});
