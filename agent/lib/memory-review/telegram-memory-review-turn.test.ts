/**
 * Interactive Telegram memory-review turn tests.
 *
 * Constructs covered:
 * - `prepareTelegramMemoryReviewTurn`: merges timeline and review sources chronologically.
 * - Duplicate and already-synchronized current entries are excluded from participant sync.
 * - Participant synchronization is split into chronological selections of at most 50 entries.
 * - The combined model-visible history is chronological without duplicate overlap or current.
 * - Conflicting trusted source metadata terminalizes the interactive batch before dispatch.
 * - Existing omitted-history notices survive a current-only interactive review batch.
 */
import { describe, expect, it, vi } from "vitest";

import {
  formatTelegramGroupJournalContext,
  type TelegramGroupJournalEntry,
} from "../telegram-group-journal-context.js";
import type { PreparedTelegramGroupTurnContext } from "../telegram-group-turn-context.js";
import { prepareTelegramMemoryReviewTurn } from "./telegram-memory-review-turn.js";

function id(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function reviewEntry(sequence: number): TelegramGroupJournalEntry {
  return {
    actorId: `telegram:${sequence}`,
    actorKind: "user",
    contentText: `review-${sequence}`,
    entryId: id(sequence),
    messageKind: "text",
    messageThreadId: null,
    replyToSequenceId: null,
    senderDisplayName: `Участник ${sequence}`,
    senderUsername: null,
    sentAt: `2026-08-13T10:${String(sequence).padStart(2, "0")}:00.000Z`,
    sequenceId: String(sequence),
  };
}

function timelineEntry(sequence: number): TelegramGroupJournalEntry {
  return {
    ...reviewEntry(sequence),
    contentText: `timeline-${sequence}`,
  };
}

function preparedContext(
  historicalSequences: readonly number[],
  currentSequence: number,
): PreparedTelegramGroupTurnContext {
  const currentEntryId = id(currentSequence);
  const historicalEntries = historicalSequences.map(timelineEntry);
  const timeline = formatTelegramGroupJournalContext(historicalEntries, 12_000);
  const currentEnvelope = [
    "<current_telegram_message>",
    JSON.stringify({ text: `current-${currentSequence}` }),
    "</current_telegram_message>",
  ].join("\n");
  return {
    cursorSequence: String(currentSequence),
    durableMessage: timeline === null ? currentEnvelope : `${timeline}\n\n${currentEnvelope}`,
    omittedBeforeSequence: null,
    currentMessageEnvelope: currentEnvelope,
    timelineOmission: null,
    visibleEntryIds: [...historicalSequences.map(id), currentEntryId],
    visibleTimelineEntries: historicalEntries,
  };
}

function repositories(entries: TelegramGroupJournalEntry[]) {
  return {
    failInteractivePreparation: vi.fn(),
    prepareInteractiveTurn: vi.fn().mockResolvedValue({
      batchId: "batch-1",
      entries,
      messageThreadId: null,
      sourceCount: entries.length,
      sourceEntryIds: entries.map((entry) => entry.entryId!),
      status: "running",
      throughSequence: entries.at(-1)?.sequenceId ?? "0",
    }),
    syncParticipants: vi.fn().mockResolvedValue(undefined),
  };
}

describe("prepareTelegramMemoryReviewTurn", () => {
  it("synchronizes interleaved timeline and review sources in bounded chronological chunks", async () => {
    const currentSequence = 99;
    const reviewSequences = Array.from({ length: 50 }, (_, index) => index * 2 + 1);
    const historicalSequences = Array.from({ length: 49 }, (_, index) => (index + 1) * 2);
    const repository = repositories(reviewSequences.map(reviewEntry));

    await prepareTelegramMemoryReviewTurn({
      applicationSessionId: "session-1",
      conversationId: "conversation-1",
      currentEntryId: id(currentSequence),
      groupId: "group-1",
      preparedContext: preparedContext(historicalSequences, currentSequence),
      repositories: {
        memoryReview: repository,
        syncParticipants: repository.syncParticipants,
      },
    });

    const synchronizedIds = repository.syncParticipants.mock.calls.flatMap(([, entryIds]) => entryIds);
    expect(synchronizedIds).toEqual(Array.from({ length: 98 }, (_, index) => id(index + 1)));
    expect(synchronizedIds).not.toContain(id(currentSequence));
    expect(repository.syncParticipants.mock.calls.map(([, entryIds]) => entryIds.length)).toEqual([
      50,
      48,
    ]);
    expect(repository.failInteractivePreparation).not.toHaveBeenCalled();
  });

  it("renders combined review, timeline, and current messages once in chronological order", async () => {
    const repository = repositories([
      reviewEntry(5),
      reviewEntry(3),
      reviewEntry(2),
      reviewEntry(1),
    ]);

    const result = await prepareTelegramMemoryReviewTurn({
      applicationSessionId: "session-1",
      conversationId: "conversation-1",
      currentEntryId: id(5),
      groupId: "group-1",
      preparedContext: preparedContext([2, 4], 5),
      repositories: {
        memoryReview: repository,
        syncParticipants: repository.syncParticipants,
      },
    });

    const synchronizedIds = repository.syncParticipants.mock.calls.flatMap(([, entryIds]) => entryIds);
    expect(synchronizedIds).toEqual([id(1), id(2), id(3), id(4)]);
    expect(new Set(synchronizedIds).size).toBe(synchronizedIds.length);
    const sequenceMarkers = ["#1 [user]", "#2 [user]", "#3 [user]", "#4 [user]"];
    const currentMarker = "<current_telegram_message>";
    expect([...sequenceMarkers, currentMarker].map((marker) =>
      result.durableMessage.indexOf(marker)
    )).toEqual([...sequenceMarkers, currentMarker]
      .map((marker) => result.durableMessage.indexOf(marker))
      .sort((left, right) => left - right));
    for (const marker of sequenceMarkers) {
      expect(result.durableMessage.split(marker)).toHaveLength(2);
    }
    expect(result.durableMessage.indexOf("current-5")).toBeGreaterThan(
      result.durableMessage.indexOf(currentMarker),
    );
    const visibleMarkers = ["review-1", "timeline-2", "review-3", "timeline-4", "current-5"];
    expect(visibleMarkers.map((marker) => result.durableMessage.indexOf(marker))).toEqual(
      [...visibleMarkers]
        .map((marker) => result.durableMessage.indexOf(marker))
        .sort((left, right) => left - right),
    );
    for (const marker of visibleMarkers) {
      expect(result.durableMessage.split(marker)).toHaveLength(2);
    }
    expect(result.durableMessage).not.toContain("review-2");
    expect(result.durableMessage).not.toContain("review-5");
    expect(result.durableMessage).toContain("<memory_review_source_selection>");
    expect(result.durableMessage).toContain(
      '\"sourceSequences\":[\"5\",\"3\",\"2\",\"1\"]',
    );
  });

  it("fails interactive preparation when duplicate source metadata has conflicting sequences", async () => {
    const conflictingReviewEntry = {
      ...reviewEntry(3),
      entryId: id(2),
    };
    const repository = repositories([conflictingReviewEntry]);

    await expect(prepareTelegramMemoryReviewTurn({
      applicationSessionId: "session-1",
      conversationId: "conversation-1",
      currentEntryId: id(5),
      groupId: "group-1",
      preparedContext: preparedContext([2, 4], 5),
      repositories: {
        memoryReview: repository,
        syncParticipants: repository.syncParticipants,
      },
    })).rejects.toMatchObject({ code: "AGENT_MEMORY_REVIEW_SOURCE_SEQUENCE_CONFLICT" });

    expect(repository.failInteractivePreparation).toHaveBeenCalledWith(
      "batch-1",
      "AGENT_MEMORY_REVIEW_CONTEXT_COMPOSITION_FAILED",
    );
    expect(repository.syncParticipants).not.toHaveBeenCalled();
  });

  it("preserves an omitted-history notice when the review batch contains only current", async () => {
    const context = preparedContext([], 5);
    context.timelineOmission = { beforeSequence: "4" };
    context.durableMessage = [
      formatTelegramGroupJournalContext([], 12_000, "4"),
      context.currentMessageEnvelope,
    ].join("\n\n");
    const repository = repositories([reviewEntry(5)]);

    const result = await prepareTelegramMemoryReviewTurn({
      applicationSessionId: "session-1",
      conversationId: "conversation-1",
      currentEntryId: id(5),
      groupId: "group-1",
      preparedContext: context,
      repositories: {
        memoryReview: repository,
        syncParticipants: repository.syncParticipants,
      },
    });

    expect(result.durableMessage).toContain("Part of the history before #4 is omitted");
    expect(result.durableMessage).toContain("current-5");
    expect(result.durableMessage.indexOf("current-5")).toBeGreaterThan(
      result.durableMessage.indexOf("Part of the history before #4 is omitted"),
    );
  });
});
