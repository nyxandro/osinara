/**
 * Telegram turn result context tests.
 *
 * Constructs covered:
 * - The verified scope, role and actor of the turn reach the model in one line.
 * - Stored files are listed; a GIF that came without a picture is named in a plain sentence.
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

describe("telegram turn attachments", () => {
  it("lists stored files and says plainly which GIF came without a picture", () => {
    const context = buildResult({
      storedAttachments: [
        { stillUnavailable: true, telegramMessageId: "41" },
        { mediaType: "image/jpeg", path: "inbox/42/photo.jpg", scope: "personal", telegramMessageId: "42" },
      ],
    }).context ?? [];

    const files = context.find((entry) => entry.startsWith("<workspace_attachments>"));
    expect(files).toContain("inbox/42/photo.jpg");
    expect(files).not.toContain("\"41\"");
    expect(context).toContain(
      "You cannot see the GIF of Telegram message 41: the server could not take a frame from its file. " +
        "Tell the person so plainly; do not guess what it shows or why it failed.",
    );
  });

  it("adds no file list when the only GIF came without a picture", () => {
    const context = buildResult({ storedAttachments: [{ stillUnavailable: true, telegramMessageId: "41" }] }).context ?? [];

    expect(context.some((entry) => entry.startsWith("<workspace_attachments>"))).toBe(false);
  });
});

// After a reconnection the agent must not claim nothing was said in the pause: it did not see it (#465).
describe("telegram turn group pause", () => {
  const group = {
    familyId: "family-1", groupId: "group-1", lastPause: {
      afterSequence: "120", endedAt: new Date("2026-12-02T09:00:00.000Z"), startedAt: new Date("2026-11-04T20:00:00.000Z"),
    },
    messageMode: "all", skillAllowlist: [], telegramChatId: "-1001", toolAllowlist: [], type: "external",
  };

  function turnContext(sequences: string[]) {
    return {
      cursorSequence: "130", durableMessage: "…", omittedBeforeSequence: null,
      visibleEntryIds: sequences.map((sequence) => `entry-${sequence}`),
      visibleTimelineEntries: sequences.map((sequenceId) => ({ sequenceId })),
    };
  }

  it("tells the agent about the pause while its visible history spans it", () => {
    const context = buildResult({ group, turnContext: turnContext(["118", "121", "130"]) } as never).context ?? [];

    const pause = context.find((entry) => entry.startsWith("<group_pause>"));
    expect(pause).toContain("2026-11-04T20:00:00.000Z");
    expect(pause).toContain("2026-12-02T09:00:00.000Z");
    expect(pause).toContain("120");
  });

  it("says nothing once the visible history starts after the pause", () => {
    const context = buildResult({ group, turnContext: turnContext(["125", "130"]) } as never).context ?? [];

    expect(context.some((entry) => entry.startsWith("<group_pause>"))).toBe(false);
  });
});

