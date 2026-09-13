/**
 * Interactive Telegram memory-review turn composition.
 *
 * Exports:
 * - `prepareTelegramMemoryReviewTurn`: binds an unprocessed tail to one ordinary group turn.
 *
 * Key constructs:
 * - Combined participant sources are deduplicated, chronological, and synchronized in bounded chunks.
 */
import { AppError } from "../app-error.js";
import { isDatabaseUnavailable } from "../database-recovery.js";
import {
  composeTelegramTurnMessage,
  type PreparedTelegramGroupTurnContext,
} from "../telegram-group-turn-context.js";
import {
  renderTelegramGroupJournalContext,
  type TelegramGroupJournalEntry,
} from "../telegram-group-journal-context.js";
import { MEMORY_REVIEW_BATCH_SIZE } from "./memory-review-config.js";
import { formatInteractiveMemoryReviewSelection } from "./memory-review-prompt.js";
import type { memoryReviewRepository } from "./memory-review-repository.js";

interface TelegramMemoryReviewTurnDependencies {
  memoryReview: Pick<
    typeof memoryReviewRepository,
    "failInteractivePreparation" | "prepareInteractiveTurn"
  >;
  syncParticipants(conversationId: string, entryIds: readonly string[]): Promise<unknown>;
}

function requiredEntryId(entry: TelegramGroupJournalEntry): string {
  if (entry.entryId === undefined) {
    throw new AppError(
      "AGENT_MEMORY_REVIEW_SOURCE_ID_MISSING",
      "Не удалось определить источник сообщения для проверки памяти",
    );
  }
  return entry.entryId;
}

function chronologicalUniqueEntries(
  entries: readonly TelegramGroupJournalEntry[],
  excludedEntryId: string,
): TelegramGroupJournalEntry[] {
  const byEntryId = new Map<string, TelegramGroupJournalEntry>();

  // Ordinary entries are inserted first because their attachment projection already passed the
  // current capability filter. Review overlap can prove identity but cannot broaden that view.
  for (const entry of entries) {
    const entryId = requiredEntryId(entry);
    if (entryId === excludedEntryId) continue;
    const existing = byEntryId.get(entryId);
    if (existing && existing.sequenceId !== entry.sequenceId) {
      throw new AppError(
        "AGENT_MEMORY_REVIEW_SOURCE_SEQUENCE_CONFLICT",
        "Не удалось упорядочить источники для проверки памяти",
      );
    }
    if (!existing) byEntryId.set(entryId, entry);
  }
  return [...byEntryId.values()].sort((left, right) => {
    const sequenceOrder = BigInt(left.sequenceId) < BigInt(right.sequenceId)
      ? -1
      : BigInt(left.sequenceId) > BigInt(right.sequenceId)
        ? 1
        : 0;
    return sequenceOrder || requiredEntryId(left).localeCompare(requiredEntryId(right));
  });
}

export async function prepareTelegramMemoryReviewTurn(input: {
  applicationSessionId: string;
  conversationId: string;
  currentEntryId: string;
  groupId: string;
  preparedContext: PreparedTelegramGroupTurnContext;
  repositories: TelegramMemoryReviewTurnDependencies;
}): Promise<PreparedTelegramGroupTurnContext> {
  const reviewBatch = await input.repositories.memoryReview.prepareInteractiveTurn({
    applicationSessionId: input.applicationSessionId,
    groupId: input.groupId,
    timelineEntryId: input.currentEntryId,
  });

  try {
    const combinedEntries = chronologicalUniqueEntries([
      ...input.preparedContext.visibleTimelineEntries,
      ...(reviewBatch?.entries ?? []),
    ], input.currentEntryId);
    const context = reviewBatch === null
      ? input.preparedContext
      : {
          ...input.preparedContext,
          durableMessage: [
            formatInteractiveMemoryReviewSelection(
              reviewBatch.entries.map((entry) => entry.sequenceId),
            ),
            composeTelegramTurnMessage(
              combinedEntries.length === 0 && input.preparedContext.timelineOmission === null
                ? null
                : renderTelegramGroupJournalContext(
                    combinedEntries,
                    input.preparedContext.timelineOmission,
                  ),
              input.preparedContext.currentMessageEnvelope,
            ),
          ].join("\n\n"),
          memoryReviewBatchId: reviewBatch.batchId,
          memoryReviewSourceEntryIds: reviewBatch.sourceEntryIds,
        };

    // The current participant was synchronized before review preparation. Remaining combined
    // sources retain chronology across repository boundaries and each query stays within 50 IDs.
    for (let offset = 0; offset < combinedEntries.length; offset += MEMORY_REVIEW_BATCH_SIZE) {
      await input.repositories.syncParticipants(
        input.conversationId,
        combinedEntries.slice(offset, offset + MEMORY_REVIEW_BATCH_SIZE).map(requiredEntryId),
      );
    }
    return context;
  } catch (error) {
    if (isDatabaseUnavailable(error)) throw error;
    if (reviewBatch) {
      await input.repositories.memoryReview.failInteractivePreparation(
        reviewBatch.batchId,
        error instanceof AppError &&
          (error.code === "AGENT_MEMORY_REVIEW_SOURCE_ID_MISSING" ||
            error.code === "AGENT_MEMORY_REVIEW_SOURCE_SEQUENCE_CONFLICT")
          ? "AGENT_MEMORY_REVIEW_CONTEXT_COMPOSITION_FAILED"
          : "AGENT_MEMORY_REVIEW_PARTICIPANT_SYNC_FAILED",
      );
    }
    throw error;
  }
}
