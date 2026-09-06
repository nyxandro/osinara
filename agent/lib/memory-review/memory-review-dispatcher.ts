/**
 * Silent memory-review dispatch orchestration.
 *
 * Exports:
 * - `ClaimedMemoryReviewBatch`: exact leased source range and verified authorization sponsor.
 * - `createMemoryReviewDispatcher`: deterministic lease-to-internal-Eve handoff processor.
 * - `dispatchPendingMemoryReviews`: production minute dispatcher.
 */
import type { ScheduleToFn } from "eve/schedules";

import memoryReviewChannel from "../../channels/memory-review.js";
import type { PreparedSession } from "../sessions/session-repository.js";
import { conversationRepository } from "../conversation-repository.js";
import {
  MEMORY_REVIEW_DISPATCH_BATCH_SIZE,
  MEMORY_REVIEW_DISPATCH_LEASE_MILLISECONDS,
} from "./memory-review-config.js";
import {
  type MemoryReviewClaim,
} from "./memory-review-repository.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryReviewSessionRepository } from "./memory-review-session-repository.js";

export type ClaimedMemoryReviewBatch = MemoryReviewClaim;

interface MemoryReviewDispatcherDependencies {
  claimPending(input: {
    leaseMilliseconds: number;
    limit: number;
    now: Date;
  }): Promise<ClaimedMemoryReviewBatch[]>;
  discardSession(
    batch: ClaimedMemoryReviewBatch,
    applicationSessionId: string,
  ): Promise<void>;
  failClaim(
    batch: ClaimedMemoryReviewBatch,
    diagnosticCode: string,
  ): Promise<"failed" | "retry_scheduled">;
  markAmbiguous(
    batch: ClaimedMemoryReviewBatch,
    diagnosticCode: string,
    applicationSessionId: string,
  ): Promise<void>;
  markDispatchStarted(
    batch: ClaimedMemoryReviewBatch,
    applicationSessionId: string,
  ): Promise<boolean>;
  markRunning(
    batch: ClaimedMemoryReviewBatch,
    input: { applicationSessionId: string; eveSessionId: string },
  ): Promise<void>;
  prepareSession(batch: ClaimedMemoryReviewBatch, now: Date): Promise<PreparedSession>;
  syncParticipants(batch: ClaimedMemoryReviewBatch): Promise<unknown>;
  to: ScheduleToFn;
}

function reviewAuth(batch: ClaimedMemoryReviewBatch, prepared: PreparedSession) {
  return {
    attributes: {
      applicationSessionId: prepared.id,
      familyId: batch.familyId,
      // A personal conversation has no group identity; the claim already carries null there.
      ...(batch.groupId === null || batch.groupType === null
        ? {}
        : { groupId: batch.groupId, groupType: batch.groupType }),
      memoryReviewBatchId: batch.batchId,
      memoryReviewMode: "background",
      memoryReviewSourceEntryIds: batch.sourceEntryIds,
      memoryScopes: batch.memoryScopes,
      role: batch.role,
      sandboxSessionId: prepared.sandboxSessionId,
      telegramActorId: batch.ownerTelegramUserId,
      telegramActorKind: "telegram_user",
      telegramChatId: batch.telegramChatId,
      telegramChatType: batch.telegramChatType,
      telegramConversationId: batch.conversationId,
      ...(batch.messageThreadId === null
        ? {}
        : { telegramForumTopicId: batch.messageThreadId }),
      telegramTimelineSequence: batch.throughSequence,
      telegramUserId: batch.ownerTelegramUserId,
      ...(batch.groupType === "external" ? { toolAllowlist: batch.toolAllowlist } : {}),
    },
    authenticator: "memory-review",
    principalId: batch.ownerUserId,
    principalType: "user",
  } as const;
}

async function dispatchOne(
  dependencies: MemoryReviewDispatcherDependencies,
  batch: ClaimedMemoryReviewBatch,
  now: Date,
): Promise<void> {
  let prepared: PreparedSession;
  try {
    await dependencies.syncParticipants(batch);
    prepared = await dependencies.prepareSession(batch, now);
  } catch (error) {
    await dependencies.failClaim(batch, "AGENT_MEMORY_REVIEW_SESSION_PREPARATION_FAILED");
    throw error;
  }

  let dispatchStarted: boolean;
  try {
    dispatchStarted = await dependencies.markDispatchStarted(batch, prepared.id);
  } catch (error) {
    await dependencies.markAmbiguous(
      batch,
      "AGENT_MEMORY_REVIEW_DISPATCH_MARKER_AMBIGUOUS",
      prepared.id,
    );
    throw error;
  }
  if (!dispatchStarted) {
    await dependencies.discardSession(batch, prepared.id);
    return;
  }

  let session: { id: string };
  try {
    // The authored internal channel selects task mode and has no Telegram delivery adapter.
    session = await dependencies.to(memoryReviewChannel, { batchId: batch.batchId })
      .send(batch.prompt, { auth: reviewAuth(batch, prepared) });
  } catch (error) {
    await dependencies.markAmbiguous(batch, "AGENT_MEMORY_REVIEW_HANDOFF_AMBIGUOUS", prepared.id);
    throw error;
  }
  await dependencies.markRunning(batch, {
    applicationSessionId: prepared.id,
    eveSessionId: session.id,
  });
}

export function createMemoryReviewDispatcher(dependencies: MemoryReviewDispatcherDependencies) {
  return async function dispatchMemoryReviews(now = new Date()): Promise<number> {
    const batches = await dependencies.claimPending({
      leaseMilliseconds: MEMORY_REVIEW_DISPATCH_LEASE_MILLISECONDS,
      limit: MEMORY_REVIEW_DISPATCH_BATCH_SIZE,
      now,
    });
    for (const batch of batches) {
      try {
        await dispatchOne(dependencies, batch, now);
      } catch (error) {
        console.error(JSON.stringify({
          batchId: batch.batchId,
          code: "AGENT_MEMORY_REVIEW_DISPATCH_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
      }
    }
    return batches.length;
  };
}

export function dispatchPendingMemoryReviews(
  to: ScheduleToFn,
  now = new Date(),
): Promise<number> {
  return createMemoryReviewDispatcher({
    claimPending: (input) => memoryReviewDispatchRepository.claimPending(input),
    discardSession: (batch, applicationSessionId) =>
      memoryReviewSessionRepository.retireUnstarted(batch, applicationSessionId),
    failClaim: (batch, code) => memoryReviewDispatchRepository.failClaim(batch, code),
    markAmbiguous: (batch, code, applicationSessionId) =>
      memoryReviewDispatchRepository.markAmbiguous(batch, code, applicationSessionId),
    markDispatchStarted: (batch, applicationSessionId) =>
      memoryReviewDispatchRepository.markDispatchStarted(batch, applicationSessionId),
    markRunning: (batch, input) => memoryReviewDispatchRepository.markRunning(batch, input),
    prepareSession: (batch, currentTime) =>
      memoryReviewSessionRepository.prepare(batch, currentTime),
    syncParticipants: (batch) => conversationRepository.syncTimelineParticipants(
      batch.conversationId,
      batch.sourceEntryIds,
    ),
    to,
  })();
}
