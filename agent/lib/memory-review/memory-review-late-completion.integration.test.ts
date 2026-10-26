/** A late completion must settle its own batch without reopening a retired chat session. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryTurnSourceRepository } from "../memory-turn-source-repository.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { insertReviewUserMessage } from "./memory-review.integration-fixtures.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("memory review completion after session rotation", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterAll(closeDatabase);

  it("closes a finished old turn and its successor without a false skipped-pass alert", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const input = {
      baseContinuationToken: `osinara:group:${fixture.groupId}:main`,
      familyId: fixture.familyId,
      groupId: fixture.groupId,
      userId: null,
      kind: "canonical" as const,
      telegramForumTopicId: null,
      scope: "family" as const,
      now: new Date(),
    };
    const oldSession = await sessionRepository.prepareTurn(input);
    await sessionRepository.bindAgentSession(oldSession.id, "agent-old");
    const oldBatch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: oldSession.id,
      groupId: fixture.groupId,
      timelineEntryId: fixture.timelineEntryId,
    });
    await memoryReviewRepository.bindAgentTurn({
      applicationSessionId: oldSession.id,
      batchId: oldBatch!.batchId,
      agentSessionId: "agent-old",
      agentTurnId: "turn-old",
    });
    // Model processing bound the source set but chose not to write a claim. This is a valid review.
    await memoryTurnSourceRepository.bind({
      applicationSessionId: oldSession.id,
      conversationId: fixture.conversationId,
      currentTimelineEntryId: fixture.timelineEntryId,
      agentSessionId: "agent-old",
      agentTurnId: "turn-old",
      invokingActorId: "agent-memory-author",
      invokingActorKind: "telegram_user",
      memoryReviewBatchId: oldBatch!.batchId,
      memoryReviewSourceEntryIds: oldBatch!.sourceEntryIds,
      visibleTimelineEntryIds: [fixture.timelineEntryId],
    });
    await sessionRepository.requestRotation(oldSession.id);
    const replacement = await sessionRepository.prepareTurn(input);
    expect(replacement.rotated).toBe(true);
    await sessionRepository.bindAgentSession(replacement.id, "agent-new");
    const source = await insertReviewUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId, sequence: 2,
    });
    const nextBatch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: replacement.id,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindAgentTurn({
      applicationSessionId: replacement.id,
      batchId: nextBatch!.batchId,
      agentSessionId: "agent-new",
      agentTurnId: "turn-new",
    });
    await memoryTurnSourceRepository.bind({
      applicationSessionId: replacement.id,
      conversationId: fixture.conversationId,
      currentTimelineEntryId: source.id,
      agentSessionId: "agent-new",
      agentTurnId: "turn-new",
      invokingActorId: "agent-memory-author",
      invokingActorKind: "telegram_user",
      memoryReviewBatchId: nextBatch!.batchId,
      memoryReviewSourceEntryIds: nextBatch!.sourceEntryIds,
      visibleTimelineEntryIds: [source.id],
    });
    await memoryReviewRepository.completeBatch({
      batchId: nextBatch!.batchId, completedAt: new Date(), agentSessionId: "agent-new", agentTurnId: "turn-new",
    });
    const before = await database().query(
      "SELECT id, completed_turns, retired_at, last_activity_at FROM conversation_sessions WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[oldSession.id, replacement.id]],
    );
    const completion = {
      batchId: oldBatch!.batchId, completedAt: new Date(), agentSessionId: "agent-old", agentTurnId: "turn-old",
    };
    await expect(memoryReviewRepository.completeBatch(completion)).resolves.toBe("recorded");
    await expect(memoryReviewRepository.completeBatch(completion)).resolves.toBe("replayed");
    expect((await database().query(
      "SELECT id, completed_turns, retired_at, last_activity_at FROM conversation_sessions WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[oldSession.id, replacement.id]],
    )).rows).toEqual(before.rows);
    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000, limit: 10, now: new Date(Date.now() + 2 * 60 * 60 * 1_000),
    });
    expect(await memoryReviewRepository.getLaneCursor({
      conversationId: fixture.conversationId, messageThreadId: null,
    })).toBe("2");
    expect((await database().query("SELECT status FROM memory_review_batches ORDER BY from_sequence")).rows)
      .toEqual([{ status: "completed" }, { status: "completed" }]);
    expect((await database().query("SELECT count(*)::integer AS count FROM memory_review_owner_alerts")).rows)
      .toEqual([{ count: 0 }]);
  });
});
