/**
 * Idle memory-review integration tests.
 *
 * Constructs covered:
 * - Background batches may hold 1..50 sources after migration 084.
 * - Full lanes (ten sources) materialize at once; idle lanes (ten minutes of silence) need at
 *   least five sources, and a long-idle lane (six hours) flushes whatever it holds.
 * - The review prompt carries already processed messages before the batch as read-only context.
 * - Personal conversations get a lazily created lane and a claimable private review batch.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  createMainAgentMemoryFixture,
  createMainAgentPrivateMemoryFixture,
} from "../memory-agent-write.integration-fixtures.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryRepository } from "../memory-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

async function insertUserMessage(input: {
  conversationId: string;
  groupId: string | null;
  sentAt: string;
  sequence: number;
}) {
  return (await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text,
        message_thread_id, sent_at)
     VALUES ($1, $2, $3, $3, 'user', 'telegram:agent-memory-author',
             'agent-memory-author', 'Анна', false, 'text', $4, NULL, $5::timestamptz)
     RETURNING id`,
    [input.conversationId, input.groupId, input.sequence,
      `Сообщение памяти ${input.sequence}`, input.sentAt],
  )).rows[0]!;
}

describeWithDatabase("idle memory review", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("accepts a background batch with fewer than 50 sources", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    const lane = await database().query<{ id: string }>(
      "SELECT id FROM memory_review_lanes WHERE conversation_id = $1",
      [fixture.conversationId],
    );

    await expect(database().query(
      `INSERT INTO memory_review_batches
         (lane_id, conversation_id, batch_kind, status, predecessor_sequence,
          from_sequence, through_sequence, source_count)
       VALUES ($1, $2, 'background', 'pending', 1, 2, 4, 3)`,
      [lane.rows[0]!.id, fixture.conversationId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("exposes attribute and occurred_at through the memory_items view", async () => {
    const columns = await database().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'memory_items' AND column_name IN ('attribute', 'occurred_at')`,
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(["attribute", "occurred_at"]);
  });

  it("materializes one pending batch for a group lane with five sources silent for ten minutes", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    const stale = "2026-09-03T10:00:00.000Z";
    for (const sequence of [2, 3, 4, 5, 6]) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId, sentAt: stale, sequence,
      });
    }

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-09-03T10:10:00.000Z"),
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      groupId: fixture.groupId,
      sourceCount: 5,
      throughSequence: "6",
    });
    expect(claims[0]!.entries.map((entry) => entry.sequenceId)).toEqual(["2", "3", "4", "5", "6"]);
  });

  it("keeps a short idle tail waiting until the long idle window flushes it", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    for (const sequence of [2, 3, 4]) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId,
        sentAt: "2026-09-03T10:00:00.000Z", sequence,
      });
    }

    const early = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T10:30:00.000Z"),
    });
    expect(early).toHaveLength(0);

    const late = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T16:00:01.000Z"),
    });
    expect(late).toHaveLength(1);
    expect(late[0]!.sourceCount).toBe(3);
  });

  it("gives the review the processed messages before the batch as read-only context", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "3",
    });
    for (const sequence of [2, 3]) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId,
        sentAt: "2026-09-03T09:00:00.000Z", sequence,
      });
    }
    for (const sequence of [4, 5, 6, 7, 8]) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId,
        sentAt: "2026-09-03T09:30:00.000Z", sequence,
      });
    }

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T10:00:00.000Z"),
    });

    expect(claims).toHaveLength(1);
    const prompt = claims[0]!.prompt;
    expect(claims[0]!.entries.map((entry) => entry.sequenceId)).toEqual(["4", "5", "6", "7", "8"]);
    expect(prompt).toContain("<preceding_context>");
    expect(prompt.indexOf("<preceding_context>")).toBeLessThan(prompt.indexOf("<untrusted_memory_review_batch>"));
    const preceding = prompt.slice(prompt.indexOf("<preceding_context>"), prompt.indexOf("</preceding_context>"));
    expect(preceding).toContain("Сообщение памяти 2");
    expect(preceding).toContain("Сообщение памяти 3");
    expect(preceding).not.toContain("Сообщение памяти 4");
  });

  it("waits while the newest unprocessed message is younger than the idle window", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    await insertUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId,
      sentAt: "2026-09-03T10:05:00.000Z", sequence: 2,
    });

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-09-03T10:10:00.000Z"),
    });

    expect(claims).toHaveLength(0);
  });

  it("materializes a batch as soon as ten fresh sources accumulate", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    for (let sequence = 2; sequence <= 11; sequence += 1) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: fixture.groupId,
        sentAt: "2026-09-03T10:09:30.000Z", sequence,
      });
    }

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-09-03T10:10:00.000Z"),
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]!.sourceCount).toBe(10);
  });

  it("does not materialize a second batch while the lane predecessor is unresolved", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    await insertUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId,
      sentAt: "2026-09-03T09:00:00.000Z", sequence: 2,
    });
    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T16:00:00.000Z"),
    });
    await insertUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId,
      sentAt: "2026-09-03T09:30:00.000Z", sequence: 3,
    });
    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date("2026-09-03T17:00:00.000Z"),
    });

    const batches = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM memory_review_batches WHERE conversation_id = $1",
      [fixture.conversationId],
    );
    expect(batches.rows[0]!.count).toBe("1");
  });

  it("claims a personal conversation batch sponsored by the conversation owner", async () => {
    const fixture = await createMainAgentPrivateMemoryFixture();
    for (const sequence of [2, 3]) {
      await insertUserMessage({
        conversationId: fixture.conversationId, groupId: null,
        sentAt: "2026-09-03T09:00:00.000Z", sequence,
      });
    }

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-09-03T16:00:00.000Z"),
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      conversationId: fixture.conversationId,
      groupId: null,
      groupType: null,
      memoryScopes: ["personal", "family"],
      ownerUserId: fixture.userId,
      role: "owner",
      scope: "personal",
      sourceCount: 3,
      telegramChatType: "private",
      toolAllowlist: [],
    });
    expect(claims[0]!.entries.map((entry) => entry.sequenceId)).toEqual(["1", "2", "3"]);
  });

  it("shows already stored claims of the conversation to the review", async () => {
    const fixture = await createMainAgentMemoryFixture();
    await memoryRepository.create(fixture.auth, {
      attribute: "работа",
      confirmation: "model_high",
      content: "Анна работает логистом",
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "current_author" },
        timelineEntryId: fixture.timelineEntryId,
      },
      kind: "profile",
      operationKey: "review-context-1",
      provenance: { sessionId: "eve-session-ctx", turnId: "eve-turn-ctx" },
      scope: "family",
      sensitivity: "normal",
      source: "eve:eve-session-ctx:eve-turn-ctx",
    });
    await memoryReviewRepository.initializeLane({
      conversationId: fixture.conversationId,
      messageThreadId: null,
      processedThroughSequence: "1",
    });
    await insertUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId,
      sentAt: "2026-09-03T09:00:00.000Z", sequence: 2,
    });

    const claims = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 10,
      now: new Date("2026-09-03T16:00:00.000Z"),
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]!.prompt).toContain("<existing_memory>");
    expect(claims[0]!.prompt).toContain("Анна работает логистом");
    expect(claims[0]!.prompt).toContain("работа");
  });
});
