/**
 * Telegram group turn entry-bound tests.
 *
 * Constructs covered:
 * - Production context preserves histories below the 99-entry history limit.
 * - Explicit current-reply ancestry survives unrelated expanded repository history.
 * - A reply chain below the configured limit remains complete.
 */
import { describe, expect, it, vi } from "vitest";

import type { TelegramGroupJournalEntry } from "./telegram-group-journal-context.js";
import { createTelegramGroupTurnContextPreparer } from "./telegram-group-turn-context.js";

function entry(sequenceId: string): TelegramGroupJournalEntry {
  return {
    actorId: `telegram:${sequenceId}`,
    actorKind: "user",
    contentText: `Сообщение ${sequenceId}`,
    entryId: `00000000-0000-4000-8000-${sequenceId.padStart(12, "0")}`,
    messageKind: "text",
    messageThreadId: null,
    replyToSequenceId: null,
    senderDisplayName: "Анна",
    senderUsername: "anna",
    sentAt: "2026-08-13T12:00:00.000Z",
    sequenceId,
  };
}

function preparer(entries: TelegramGroupJournalEntry[]) {
  return createTelegramGroupTurnContextPreparer({
    journal: {
      listIncremental: vi.fn(),
      listRecent: vi.fn().mockResolvedValue(entries),
    },
    sessions: {
      currentGroupTimelineCursor: vi.fn().mockResolvedValue(null),
    },
  });
}

const input = {
  applicationSessionId: "session-1",
  attachmentReferenceAccess: "all" as const,
  currentEntryId: "00000000-0000-4000-8000-000000000100",
  currentSenderDisplayName: "Пух",
  currentSenderUsername: "nyxandro",
  currentSequence: "100",
  groupId: "group-1",
  messageText: "Что решили?",
  messageThreadId: null,
  replyTargetUnavailable: false,
  replyToSequenceId: null,
  triggeredBy: "mention" as const,
};

describe("Telegram group turn context entry bounds", () => {
  it("preserves current reply ancestry when history remains below the 99-entry limit", async () => {
    const expandedHistory = Array.from({ length: 83 }, (_, index) => {
      const sequenceId = String(index + 1);
      return {
        ...entry(sequenceId),
        replyToSequenceId: sequenceId === "2" ? "1" : null,
      };
    });

    const result = await preparer(expandedHistory)({
      ...input,
      currentSequence: "84",
      replyToSequenceId: "2",
    });

    expect(result.visibleEntryIds).toHaveLength(84);
    expect(result.visibleEntryIds).toContain("00000000-0000-4000-8000-000000000001");
    expect(result.visibleEntryIds).toContain("00000000-0000-4000-8000-000000000002");
    expect(result.visibleEntryIds).toContain("00000000-0000-4000-8000-000000000083");
    expect(result.visibleEntryIds.at(-1)).toBe(input.currentEntryId);
    expect(result.durableMessage).toContain("#1 [user]");
    expect(result.durableMessage).toContain("#2 [user]");
  });

  it("keeps a complete 51-message reply chain below the history limit", async () => {
    const expandedChain = Array.from({ length: 51 }, (_, index) => {
      const sequenceId = String(index + 1);
      return {
        ...entry(sequenceId),
        replyToSequenceId: index === 0 ? null : String(index),
      };
    });

    const result = await preparer(expandedChain)({ ...input, currentSequence: "52" });

    expect(result.visibleEntryIds).toHaveLength(52);
    expect(result.visibleEntryIds.slice(0, 2)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(result.visibleEntryIds.at(-2)).toBe("00000000-0000-4000-8000-000000000051");
    expect(result.visibleEntryIds.at(-1)).toBe(input.currentEntryId);
    expect(result.durableMessage).toContain("#51 [user]");
    expect(result.durableMessage).toContain("#1 [user]");
  });
});
