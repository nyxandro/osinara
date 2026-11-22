/**
 * Private Telegram timeline participant-selection regression tests.
 *
 * Constructs covered:
 * - A full private timeline is synchronized in repository-bounded chunks after the current entry.
 * - Duplicate trusted entry IDs remain fail-closed even when they cross a chunk boundary.
 */
import { expect, it } from "vitest";

import {
  privateMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

function timelineEntryId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function privateRepository(visibleEntryIds: string[]) {
  const repository = repositories();
  repository.telegram.findIdentity.mockResolvedValue({
    familyId: "family-1",
    role: "owner",
    userId: "user-1",
  });
  repository.groupContext.prepare.mockResolvedValue({
    cursorSequence: String(visibleEntryIds.length),
    currentMessageEnvelope: "<current_telegram_message>test</current_telegram_message>",
    durableMessage: "<current_telegram_message>test</current_telegram_message>",
    omittedBeforeSequence: null,
    visibleEntryIds,
    visibleTimelineEntries: [],
  });
  repository.conversations.syncTimelineParticipants.mockImplementation(
    async (_conversationId, entryIds) => {
      if (entryIds.length === 0 || entryIds.length > 50 || new Set(entryIds).size !== entryIds.length) {
        throw new Error("AGENT_CONVERSATION_TIMELINE_SELECTION_INVALID");
      }
      return [];
    },
  );
  return repository;
}

it("chunks a full private timeline after synchronizing the current participant", async () => {
  const currentEntryId = timelineEntryId(11);
  const repository = privateRepository(
    Array.from({ length: 84 }, (_, index) => timelineEntryId(index + 1)),
  );
  const handler = createTelegramMessageHandler(repository);

  await expect(handler(telegramContext().context, privateMessage("куку"))).resolves.toBeTruthy();

  expect(repository.conversations.syncTimelineParticipants.mock.calls.map(([, entryIds]) => entryIds.length))
    .toEqual([1, 50, 33]);
  const additionalEntryIds = repository.conversations.syncTimelineParticipants.mock.calls
    .slice(1)
    .flatMap(([, entryIds]) => entryIds);
  expect(additionalEntryIds).not.toContain(currentEntryId);
  expect(new Set(additionalEntryIds).size).toBe(additionalEntryIds.length);
});

it("rejects duplicate private timeline entries across chunk boundaries", async () => {
  const visibleEntryIds = Array.from({ length: 52 }, (_, index) => timelineEntryId(index + 1));
  visibleEntryIds[51] = visibleEntryIds[0]!;
  const repository = privateRepository(visibleEntryIds);
  const handler = createTelegramMessageHandler(repository);

  await expect(handler(telegramContext().context, privateMessage("куку")))
    .rejects.toThrowError(/AGENT_CONVERSATION_TIMELINE_SELECTION_INVALID/u);
});
