/** A late completion must settle its own batch without reopening a retired chat session. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryTurnSourceRepository } from "../memory-turn-source-repository.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { insertReviewUserMessage } from "./memory-review.integration-fixtures.js";
import { createTelegramMessageHandler } from "../telegram-on-message.js";
import { groupMessage, repositories, telegramContext } from "../telegram-on-message.test-fixtures.js";
import { conversationRepository } from "../conversation-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("memory review completion after session rotation", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families CASCADE"); });
  afterAll(closeDatabase);

  it("does not orphan a second review batch when a reply resumes a pending turn", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const sessionInput = {
      baseContinuationToken: `osinara:group:${fixture.groupId}:main`,
      familyId: fixture.familyId, groupId: fixture.groupId, kind: "canonical" as const,
      now: new Date(), scope: "family" as const, telegramForumTopicId: null, userId: null,
    };
    const original = await sessionRepository.prepareTurn(sessionInput);
    await sessionRepository.bindEveSession(original.id, "eve-pending");
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: original.id, groupId: fixture.groupId, timelineEntryId: fixture.timelineEntryId,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: original.id, batchId: batch!.batchId, eveSessionId: "eve-pending", eveTurnId: "turn-1",
    });
    await memoryTurnSourceRepository.bind({
      applicationSessionId: original.id, conversationId: fixture.conversationId,
      currentTimelineEntryId: fixture.timelineEntryId, eveSessionId: "eve-pending", eveTurnId: "turn-1",
      invokingActorId: "agent-memory-author", invokingActorKind: "telegram_user",
      memoryReviewBatchId: batch!.batchId, memoryReviewSourceEntryIds: batch!.sourceEntryIds,
      visibleTimelineEntryIds: [fixture.timelineEntryId],
    });
    await sessionRepository.parkSession({
      applicationSessionId: original.id, pendingRequestId: "question-1",
      requesterTelegramUserId: "agent-memory-author", requesterUserId: fixture.userId,
    });
    await sessionRepository.registerRouteAlias(original.id, "group-101::9000");
    const reply = await insertReviewUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId, sequence: 2,
    });
    const deps = repositories();
    deps.telegram.findGroup.mockResolvedValue({
      familyId: fixture.familyId, groupId: fixture.groupId, messageMode: "addressed_only",
      skillAllowlist: [], telegramChatId: "group-101", toolAllowlist: [], type: "family_private",
    });
    deps.telegram.findIdentity.mockResolvedValue({ familyId: fixture.familyId, role: "owner", userId: fixture.userId });
    deps.hitl.authorizeReply.mockResolvedValue("authorized");
    deps.journal.record.mockResolvedValue({
      entryId: reply.id, replyToAgent: true, replyTargetUnavailable: false,
      replyToSequenceId: "1", sequenceId: "2", status: "inserted",
    });
    const handler = createTelegramMessageHandler({
      ...deps, conversations: conversationRepository, session: { ...sessionRepository,
        prepareAuthorizedResponse: async () => ({ ...original,nativeSessionId: "eve-pending" }) }, memoryReview: memoryReviewRepository,
    });
    const result = await handler({ ...telegramContext().context,ingressRecovery: { updateId: "2",dispatchId: crypto.randomUUID() } }, {
      ...groupMessage("да"), messageId: "2",
      from: { firstName: "User", id: "agent-memory-author", isBot: false },
      replyToMessage: {
        messageId: "9000", chat: { id: "group-101", type: "group" },
        from: { id: "bot", firstName: "Osinara", isBot: true, username: "osinara_bot" },
      },
    });
    expect(result).not.toBeNull();
    expect(result?.auth?.attributes.memoryReviewBatchId).toBeUndefined();
    expect((await database().query("SELECT id FROM memory_review_batches")).rows).toEqual([{ id: batch!.batchId }]);
    await sessionRepository.resumePendingSession(original.id, "eve-pending");
    await memoryReviewRepository.completeBatch({
      batchId: batch!.batchId, completedAt: new Date(), eveSessionId: "eve-pending", eveTurnId: "turn-1",
    });
    const next = await sessionRepository.prepareTurn(sessionInput);
    const third = await insertReviewUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId, sequence: 3,
    });
    const nextBatch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: next.id, groupId: fixture.groupId, timelineEntryId: third.id,
    });
    expect(nextBatch?.sourceEntryIds).toEqual([reply.id, third.id]);
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: next.id, batchId: nextBatch!.batchId, eveSessionId: "eve-next", eveTurnId: "turn-0",
    });
    await memoryTurnSourceRepository.bind({
      applicationSessionId: next.id, conversationId: fixture.conversationId, currentTimelineEntryId: third.id,
      eveSessionId: "eve-next", eveTurnId: "turn-0", invokingActorId: "agent-memory-author", invokingActorKind: "telegram_user",
      memoryReviewBatchId: nextBatch!.batchId, memoryReviewSourceEntryIds: nextBatch!.sourceEntryIds,
      visibleTimelineEntryIds: [reply.id, third.id],
    });
    await memoryReviewRepository.completeBatch({
      batchId: nextBatch!.batchId, completedAt: new Date(), eveSessionId: "eve-next", eveTurnId: "turn-0",
    });
    await memoryReviewDispatchRepository.claimPending({ leaseMilliseconds: 60_000, limit: 10, now: new Date(Date.now() + 2 * 60 * 60 * 1_000) });
    expect(await memoryReviewRepository.getLaneCursor({ conversationId: fixture.conversationId, messageThreadId: null })).toBe("3");
    expect((await database().query("SELECT count(*)::integer AS count FROM memory_review_owner_alerts")).rows).toEqual([{ count: 0 }]);
  });

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
    await sessionRepository.bindEveSession(oldSession.id, "eve-old");
    const oldBatch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: oldSession.id,
      groupId: fixture.groupId,
      timelineEntryId: fixture.timelineEntryId,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: oldSession.id,
      batchId: oldBatch!.batchId,
      eveSessionId: "eve-old",
      eveTurnId: "turn-old",
    });
    // Model processing bound the source set but chose not to write a claim. This is a valid review.
    await memoryTurnSourceRepository.bind({
      applicationSessionId: oldSession.id,
      conversationId: fixture.conversationId,
      currentTimelineEntryId: fixture.timelineEntryId,
      eveSessionId: "eve-old",
      eveTurnId: "turn-old",
      invokingActorId: "agent-memory-author",
      invokingActorKind: "telegram_user",
      memoryReviewBatchId: oldBatch!.batchId,
      memoryReviewSourceEntryIds: oldBatch!.sourceEntryIds,
      visibleTimelineEntryIds: [fixture.timelineEntryId],
    });
    await sessionRepository.requestRotation(oldSession.id);
    const replacement = await sessionRepository.prepareTurn(input);
    expect(replacement.rotated).toBe(true);
    await sessionRepository.bindEveSession(replacement.id, "eve-new");
    const source = await insertReviewUserMessage({
      conversationId: fixture.conversationId, groupId: fixture.groupId, sequence: 2,
    });
    const nextBatch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: replacement.id,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: replacement.id,
      batchId: nextBatch!.batchId,
      eveSessionId: "eve-new",
      eveTurnId: "turn-new",
    });
    await memoryTurnSourceRepository.bind({
      applicationSessionId: replacement.id,
      conversationId: fixture.conversationId,
      currentTimelineEntryId: source.id,
      eveSessionId: "eve-new",
      eveTurnId: "turn-new",
      invokingActorId: "agent-memory-author",
      invokingActorKind: "telegram_user",
      memoryReviewBatchId: nextBatch!.batchId,
      memoryReviewSourceEntryIds: nextBatch!.sourceEntryIds,
      visibleTimelineEntryIds: [source.id],
    });
    await memoryReviewRepository.completeBatch({
      batchId: nextBatch!.batchId, completedAt: new Date(), eveSessionId: "eve-new", eveTurnId: "turn-new",
    });
    const before = await database().query(
      "SELECT id, completed_turns, retired_at, last_activity_at FROM conversation_sessions WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[oldSession.id, replacement.id]],
    );
    const completion = {
      batchId: oldBatch!.batchId, completedAt: new Date(), eveSessionId: "eve-old", eveTurnId: "turn-old",
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
