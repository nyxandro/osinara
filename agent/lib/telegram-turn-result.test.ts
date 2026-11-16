/**
 * Telegram turn result context tests.
 *
 * Constructs covered:
 * - The verified scope, role and actor of the turn reach the model in one line.
 * - Stored files are listed; a GIF that came without a picture is named in a plain sentence.
 * - A photo, file or voice message that did not reach the agent is named with its reason, so the
 *   agent tells the person in its own words (owner's decision of 16.11.2026).
 */
import { describe, expect, it } from "vitest";

import { buildTelegramTurnResult } from "./telegram-turn-result.js";
import { UNRECEIVED_VOICE_FIELD } from "./unreceived-telegram-files.js";

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
        { kind: "animation", telegramMessageId: "41", unreceived: "picture_unavailable" },
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
    const context = buildResult({
      storedAttachments: [{ kind: "animation", telegramMessageId: "41", unreceived: "picture_unavailable" }],
    }).context ?? [];

    expect(context.some((entry) => entry.startsWith("<workspace_attachments>"))).toBe(false);
  });
});

describe("telegram turn files that did not arrive", () => {
  it("names a photo Telegram did not hand over and asks the agent to explain it in its own words", () => {
    const context = buildResult({
      storedAttachments: [{ kind: "photo", telegramMessageId: "41", unreceived: "telegram_failure" }],
    }).context ?? [];

    expect(context.some((entry) => entry.startsWith("<workspace_attachments>"))).toBe(false);
    expect(context).toContain(
      "The photo of Telegram message 41 did not reach you: Telegram did not hand its file over to the bot, a failure on Telegram's side. " +
        "In your own words, without codes or technical terms, tell the person that Telegram is glitching and the photo did not come through, " +
        "and ask them to send it again. If it already failed like this earlier in this chat, say it failed again and suggest trying a bit later. " +
        "Do not guess what it contains.",
    );
  });

  it("names a file over the 20 MB a bot may receive", () => {
    const context = buildResult({
      storedAttachments: [{ kind: "document", telegramMessageId: "41", unreceived: "too_large" }],
    }).context ?? [];

    expect(context).toContain(
      "The file of Telegram message 41 did not reach you: it is larger than the 20 MB Telegram lets a bot receive. " +
        "In your own words, tell the person so and suggest a smaller file, a few parts or a link. Do not guess what it contains.",
    );
  });

  it.each([
    ["telegram_failure", "The voice message did not reach you: Telegram did not hand its recording over to the bot"],
    ["too_large", "The voice message did not reach you: it is larger than the 20 MB Telegram lets a bot receive."],
    ["speech_unrecognized", "No speech could be made out in the voice message."],
    ["recognition_unavailable", "Speech recognition did not work, so you do not know what the voice message says."],
  ])("explains a voice message marked %s at ingress", (reason, sentence) => {
    const context = buildResult({
      message: {
        chat: { id: "555", type: "private" }, messageId: "42", raw: { [UNRECEIVED_VOICE_FIELD]: reason, voice: { duration: 3 } },
      },
    } as never).context ?? [];

    expect(context.filter((entry) => entry.includes("voice message"))).toEqual([expect.stringContaining(sentence)]);
  });

  it("says nothing about a voice message that arrived", () => {
    const context = buildResult({
      message: { chat: { id: "555", type: "private" }, messageId: "42", raw: { voice: { duration: 3 } }, text: "Купи молоко" },
    } as never).context ?? [];

    expect(context.some((entry) => entry.includes("voice message"))).toBe(false);
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

