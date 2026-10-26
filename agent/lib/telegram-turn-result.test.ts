/**
 * Telegram turn result context tests.
 *
 * Constructs covered:
 * - The verified scope, role and actor of the turn reach the model in one line.
 */
import { describe, expect, it } from "vitest";

import { buildTelegramTurnResult } from "./telegram-turn-result.js";

type TurnResultInput = Parameters<typeof buildTelegramTurnResult>[0];

function buildInput(overrides: Partial<TurnResultInput> = {}) {
  return {
    access: { familyId: "family-1", groupId: null, memoryScopes: ["personal"], role: "owner", userId: "user-1" },
    actor: { actorId: "actor-1", displayName: "Аня", id: "8123", kind: "telegram_user", username: "anya" },
    appSession: { continuationToken: "token-1", id: "app-session-1", sandboxSessionId: "sandbox-1" },
    conversation: { id: "conversation-1" },
    forumTopicId: null,
    group: null,
    groupTurnTrigger: null,
    lazyAttachment: null,
    message: { chat: { id: "555", type: "private" }, messageId: "42" },
    pendingDelivery: null,
    plannedWakeups: [],
    profileReplyTimelineSequence: null,
    profileSignals: { explicitMentionTelegramUserIds: [], replyTelegramUserId: null },
    shownDuringTurn: null,
    storedAttachments: [],
    timelineEntryId: "entry-1",
    turnContext: {
      cursorSequence: "7",
      durableMessage: "<current_telegram_message>…</current_telegram_message>",
      omittedBeforeSequence: null,
      visibleEntryIds: ["entry-1"],
    },
    turnInterjectionMarker: null,
    turnStartedAt: new Date("2026-09-18T12:00:00.000Z"),
    ...overrides,
  } as unknown as TurnResultInput;
}

function buildResult(overrides: Partial<TurnResultInput> = {}) {
  // The channel contract allows a turn to produce nothing, so the declared type is nullable.
  // This builder never does; narrowing here keeps every test from restating that.
  const result = buildTelegramTurnResult(buildInput(overrides));
  expect(result, "buildTelegramTurnResult returned no result").not.toBeNull();
  return result!;
}

describe("telegram turn verified facts", () => {
  it("states the verified scope, role and actor of the turn in one line", () => {
    const context = buildResult().context ?? [];

    expect(context.filter((entry) => entry.startsWith("Verified"))).toEqual([
      "Verified turn: scope personal; role owner; actor telegram_user.",
    ]);
  });
});
