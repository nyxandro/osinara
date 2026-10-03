/**
 * Silent memory-review dispatcher unit tests.
 *
 * Constructs covered:
 * - `createMemoryReviewDispatcher`: one claimed 50-message batch starts one internal review turn.
 * - Failed pre-handoff work schedules repository-owned bounded recovery.
 * - A possibly-started handoff becomes ambiguous and is never retried automatically.
 * - One broken claim cannot block the remaining already-claimed reviews.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createMemoryReviewDispatcher,
  type ClaimedMemoryReviewBatch,
} from "./memory-review-dispatcher.js";

const batch: ClaimedMemoryReviewBatch = {
  batchId: "00000000-0000-4000-8000-000000000050",
  conversationId: "00000000-0000-4000-8000-000000000040",
  entries: [],
  familyId: "00000000-0000-4000-8000-000000000010",
  groupId: "00000000-0000-4000-8000-000000000020",
  groupType: "family_private",
  leaseToken: "00000000-0000-4000-8000-000000000060",
  messageThreadId: null,
  ownerTelegramUserId: "101",
  ownerUserId: "00000000-0000-4000-8000-000000000030",
  prompt: "<untrusted_memory_review_batch>\n50 messages\n</untrusted_memory_review_batch>",
  scope: "family",
  sourceCount: 50,
  sourceEntryIds: Array.from(
    { length: 50 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  ),
  telegramChatId: "-1001234567890",
  telegramChatType: "supergroup",
  throughSequence: "50",
  toolAllowlist: [],
  status: "pending",
};

function dependencies(overrides: Record<string, unknown> = {}) {
  const startReview = vi.fn().mockResolvedValue({ sessionId: "eve-review-session-1" });
  return {
    dependencies: {
      claimPending: vi.fn().mockResolvedValue([batch]),
      discardSession: vi.fn(),
      failClaim: vi.fn(),
      markAmbiguous: vi.fn(),
      markDispatchStarted: vi.fn().mockResolvedValue(true),
      markRunning: vi.fn(),
      prepareSession: vi.fn().mockResolvedValue({
        continuationToken: `memory-review:${batch.batchId}`,
        generation: 0,
        id: "application-review-session-1",
        rotated: false,
        sandboxSessionId: "00000000-0000-4000-8000-000000000070",
      }),
      startReview,
      syncParticipants: vi.fn(),
      ...overrides,
    },
    startReview,
  };
}

describe("memory review dispatcher", () => {
  it("starts exactly one internal task turn for one 50-message batch", async () => {
    const fixture = dependencies();

    await expect(createMemoryReviewDispatcher(fixture.dependencies as never)(
      new Date("2026-08-12T10:00:00.000Z"),
    )).resolves.toBe(1);

    expect(fixture.dependencies.syncParticipants).toHaveBeenCalledWith(batch);
    expect(fixture.startReview).toHaveBeenCalledTimes(1);
    expect(fixture.startReview).toHaveBeenCalledWith(batch.batchId, batch.prompt, {
      auth: expect.objectContaining({
        attributes: expect.objectContaining({
          applicationSessionId: "application-review-session-1",
          memoryReviewBatchId: batch.batchId,
          memoryReviewMode: "background",
          memoryReviewSourceEntryIds: batch.sourceEntryIds,
          memoryScopes: ["family"],
          telegramActorId: batch.ownerTelegramUserId,
          telegramActorKind: "telegram_user",
          telegramConversationId: batch.conversationId,
          telegramTimelineSequence: "50",
        }),
        authenticator: "memory-review",
        principalId: batch.ownerUserId,
        principalType: "user",
      }),
    });
    expect(fixture.dependencies.markDispatchStarted).toHaveBeenCalledWith(
      batch,
      "application-review-session-1",
    );
    expect(fixture.dependencies.markRunning).toHaveBeenCalledWith(batch, {
      applicationSessionId: "application-review-session-1",
      eveSessionId: "eve-review-session-1",
    });
  });

  it("marks a rejected handoff ambiguous because its turn may already exist", async () => {
    const fixture = dependencies({
      startReview: vi.fn().mockRejectedValue(new Error("connection lost")),
    });

    await createMemoryReviewDispatcher(fixture.dependencies as never)();

    expect(fixture.dependencies.markAmbiguous).toHaveBeenCalledWith(
      batch,
      "AGENT_MEMORY_REVIEW_HANDOFF_AMBIGUOUS",
      "application-review-session-1",
    );
    expect(fixture.dependencies.failClaim).not.toHaveBeenCalled();
    expect(fixture.dependencies.discardSession).not.toHaveBeenCalled();
  });

  it("retires the prepared session when the dispatch marker outcome is ambiguous", async () => {
    const fixture = dependencies({
      markDispatchStarted: vi.fn().mockRejectedValue(new Error("database connection lost")),
    });

    await createMemoryReviewDispatcher(fixture.dependencies as never)();

    expect(fixture.dependencies.markAmbiguous).toHaveBeenCalledWith(
      batch,
      "AGENT_MEMORY_REVIEW_DISPATCH_MARKER_AMBIGUOUS",
      "application-review-session-1",
    );
    expect(fixture.startReview).not.toHaveBeenCalled();
  });

  it("does not retire a reused session after another worker acquired the batch", async () => {
    const fixture = dependencies({
      markDispatchStarted: vi.fn().mockResolvedValue(false),
    });

    await createMemoryReviewDispatcher(fixture.dependencies as never)();

    expect(fixture.dependencies.discardSession).toHaveBeenCalledWith(
      batch,
      "application-review-session-1",
    );
    expect(fixture.startReview).not.toHaveBeenCalled();
  });

  it("schedules bounded recovery before handoff and continues with another claimed batch", async () => {
    const second = { ...batch, batchId: "00000000-0000-4000-8000-000000000051" };
    const fixture = dependencies({
      claimPending: vi.fn().mockResolvedValue([batch, second]),
      prepareSession: vi.fn()
        .mockRejectedValueOnce(new Error("database unavailable"))
        .mockResolvedValueOnce({
          continuationToken: `memory-review:${second.batchId}`,
          generation: 0,
          id: "application-review-session-2",
          rotated: false,
          sandboxSessionId: "00000000-0000-4000-8000-000000000071",
        }),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(createMemoryReviewDispatcher(fixture.dependencies as never)()).resolves.toBe(2);

    expect(fixture.dependencies.failClaim).toHaveBeenCalledWith(
      batch,
      "AGENT_MEMORY_REVIEW_SESSION_PREPARATION_FAILED",
    );
    expect(fixture.startReview).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.markRunning).toHaveBeenCalledWith(second, expect.any(Object));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("AGENT_MEMORY_REVIEW_DISPATCH_FAILED"));
    consoleError.mockRestore();
  });
});
