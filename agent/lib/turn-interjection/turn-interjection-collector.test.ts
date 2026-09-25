/**
 * Turn interjection collector tests.
 *
 * Constructs covered:
 * - Only a root turn whose preparation announced a marker looks into its queue.
 * - Only messages of the same person reach the turn; in a group, only those addressed to the bot.
 * - A message whose own processing would land in another conversation, or that answers or meets a
 *   pending confirmation, keeps waiting as before; a reply to this conversation's message is shown.
 * - Messages the bot will not show do not use up the window of shown messages.
 * - Voice is claimed and marked as started before the paid transcription; at most two recordings
 *   are transcribed per tool call.
 * - A failed transcription and every file arrive as a notice, and the claim records exactly that.
 * - Every call first frees its earlier attempt's claims; anything failing after the claim releases
 *   it; a successful result marks it returned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTurnInterjectionCollector, type TurnInterjectionCollectorDependencies } from "./turn-interjection-collector.js";
import type { TurnInterjectionCandidate } from "./turn-interjection-repository.js";

const BOT = "osinara_bot";
const SESSION = "00000000-0000-4000-8000-0000000000a1";
const MARKER = "0123456789abcdef01234567";

function toolContext(attributes: Record<string, unknown>, parent?: unknown) {
  return {
    callId: "call-1",
    session: {
      auth: {
        current: {
          attributes: {
            applicationSessionId: SESSION,
            familyId: "family-1",
            osinaraTelegramUpdateId: "500",
            role: "owner",
            telegramActorKind: "telegram_user",
            telegramChatId: "101",
            telegramChatType: "private",
            telegramTurnInterjectionMarker: MARKER,
            telegramUserId: "101",
            ...attributes,
          },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "ses_1",
      ...(parent === undefined ? {} : { parent }),
      turn: { id: "turn_2" },
    },
  } as never;
}

const GROUP_ATTRIBUTES = {
  groupId: "group-1",
  groupType: "family_private",
  telegramChatId: "-2001",
  telegramChatType: "supergroup",
};

function candidate(updateId: string, message: Record<string, unknown>, extra: Partial<TurnInterjectionCandidate> = {}): TurnInterjectionCandidate {
  return {
    albumMemberCount: 0,
    payload: {
      message: {
        chat: { id: 101, type: "private" },
        date: 1_790_000_000,
        from: { id: 101, is_bot: false },
        message_id: Number(updateId),
        ...message,
      },
      update_id: Number(updateId),
    },
    updateId,
    voice: null,
    voiceTranscript: null,
    ...extra,
  };
}

function voiceCandidate(updateId: string, extra: Partial<TurnInterjectionCandidate> = {}) {
  return candidate(updateId, { voice: { file_id: `voice-${updateId}` } }, { voice: { fileId: `voice-${updateId}` }, ...extra });
}

function groupCandidate(updateId: string, text: string): TurnInterjectionCandidate {
  return candidate(updateId, { chat: { id: -2001, type: "supergroup" }, text });
}

type Mocked<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? ReturnType<typeof vi.fn<(...args: A) => R>> : T[K] };

let dependencies: Omit<TurnInterjectionCollectorDependencies, "repository"> & {
  authorizeVoice: ReturnType<typeof vi.fn>;
  repository: Mocked<TurnInterjectionCollectorDependencies["repository"]>;
  transcribeVoice: ReturnType<typeof vi.fn>;
};
let candidates: TurnInterjectionCandidate[];
let owned: ((updateId: string) => boolean);
const events: string[] = [];

beforeEach(() => {
  candidates = [];
  owned = () => true;
  events.length = 0;
  dependencies = {
    authorizeVoice: vi.fn(async () => true),
    botUsername: BOT,
    repository: {
      beginEarlyVoiceTranscription: vi.fn(async (updateId: string) => {
        events.push(`begin:${updateId}`);
        return { status: "started" as const };
      }),
      claim: vi.fn(async (_coordinate: unknown, messages: readonly { contentKind: string; updateId: string }[]) => {
        events.push(`claim:${messages.map((message) => `${message.updateId}=${message.contentKind}`).join(",")}`);
        return new Set<string>(messages.map((message) => message.updateId).filter(owned));
      }),
      isReplyToPendingConfirmation: vi.fn(async () => false),
      listCandidates: vi.fn(async () => candidates),
      markReturned: vi.fn(async (_coordinate: unknown, updateIds: readonly string[]) => {
        events.push(`returned:${updateIds.join(",")}`);
      }),
      releaseCall: vi.fn(async () => {
        events.push("release");
      }),
      routeSessionId: vi.fn(async () => SESSION),
      saveEarlyVoiceTranscript: vi.fn(async (_updateId: string, transcript: string) => transcript),
    },
    transcribeVoice: vi.fn(async ({ fileId }: { fileId: string }) => {
      events.push(`transcribe:${fileId}`);
      return "и ещё добавь цены";
    }),
  };
});

function blockMessages(block: string | null): Array<Record<string, unknown>> {
  expect(block).not.toBeNull();
  expect(block!.startsWith(`<messages_while_working marker="${MARKER}">`)).toBe(true);
  return JSON.parse(block!.split("\n").at(-2)!).messages;
}

describe("turn interjection eligibility", () => {
  it.each([
    ["a delegated child turn", {}, { callId: "parent-call" }],
    ["a turn without its ingress update", { osinaraTelegramUpdateId: undefined }, undefined],
    ["a turn whose preparation announced no marker", { telegramTurnInterjectionMarker: undefined }, undefined],
    ["a scheduled run", { scheduledRunId: "00000000-0000-4000-8000-000000000001" }, undefined],
    ["an external group", { ...GROUP_ATTRIBUTES, groupType: "external" }, undefined],
    ["a channel author", { telegramActorKind: "telegram_channel" }, undefined],
  ])("does not look into the queue for %s", async (_label, attributes, parent) => {
    candidates = [candidate("501", { text: "стоп" })];
    const { collect } = createTurnInterjectionCollector(dependencies);

    expect(await collect(toolContext(attributes, parent))).toBeNull();
    expect(dependencies.repository.listCandidates).not.toHaveBeenCalled();
  });
});

describe("createTurnInterjectionCollector", () => {
  it("shows a waiting text of the same person, claims it for this call and marks it returned", async () => {
    candidates = [candidate("501", { text: "Стоп, не Москва, а Питер" })];
    const { collect } = createTurnInterjectionCollector(dependencies);

    const block = await collect(toolContext({}));

    expect(dependencies.repository.listCandidates).toHaveBeenCalledWith(expect.objectContaining({
      currentUpdateId: "500",
      eveSessionId: "ses_1",
      eveTurnId: "turn_2",
      telegramUserId: "101",
      toolCallId: "call-1",
    }));
    expect(dependencies.repository.routeSessionId).toHaveBeenCalledWith("101::");
    expect(dependencies.repository.claim).toHaveBeenCalledWith(
      expect.objectContaining({ applicationSessionId: SESSION, toolCallId: "call-1" }),
      [{ contentKind: "text", updateId: "501" }],
    );
    expect(blockMessages(block)).toEqual([expect.objectContaining({ kind: "text", text: "Стоп, не Москва, а Питер" })]);
    expect(events).toEqual(["release", "claim:501=text", "returned:501"]);
  });

  it("returns nothing when no message waits or another call owns every one", async () => {
    const { collect } = createTurnInterjectionCollector(dependencies);
    expect(await collect(toolContext({}))).toBeNull();
    expect(dependencies.repository.claim).not.toHaveBeenCalled();

    candidates = [candidate("501", { text: "стоп" })];
    owned = () => false;
    expect(await collect(toolContext({}))).toBeNull();
    expect(dependencies.repository.markReturned).not.toHaveBeenCalled();
  });

  it("leaves a message for another conversation waiting", async () => {
    candidates = [candidate("501", { text: "стоп" })];
    dependencies.repository.routeSessionId.mockResolvedValue("00000000-0000-4000-8000-0000000000b2");
    const { collect } = createTurnInterjectionCollector(dependencies);

    expect(await collect(toolContext({}))).toBeNull();
    expect(dependencies.repository.claim).not.toHaveBeenCalled();
  });

  it("shows a reply to this conversation's message but leaves a reply to a confirmation waiting", async () => {
    const replyToBot = (updateId: string, messageId: number, text: string) => candidate(updateId, {
      reply_to_message: { chat: { id: 101, type: "private" }, from: { id: 999, is_bot: true, username: BOT }, message_id: messageId },
      text,
    });
    candidates = [replyToBot("501", 7, "да"), replyToBot("502", 8, "стоп, не то")];
    dependencies.repository.isReplyToPendingConfirmation.mockImplementation(async ({ replyMessageId }) => replyMessageId === "7");
    const { collect } = createTurnInterjectionCollector(dependencies);

    expect(blockMessages(await collect(toolContext({})))).toEqual([expect.objectContaining({ text: "стоп, не то" })]);
    expect(dependencies.repository.isReplyToPendingConfirmation).toHaveBeenCalledWith({
      replyMessageId: "8",
      replyRouteToken: "101::8",
      telegramChatId: "101",
    });
    // A private reply follows the route of the message it answers.
    expect(dependencies.repository.routeSessionId).toHaveBeenCalledWith("101::8");
  });

  it("does not check confirmations for a reply to a person", async () => {
    candidates = [candidate("501", {
      reply_to_message: { chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false }, message_id: 8 },
      text: "и это тоже",
    })];
    const { collect } = createTurnInterjectionCollector(dependencies);

    expect(blockMessages(await collect(toolContext({})))).toEqual([expect.objectContaining({ text: "и это тоже" })]);
    expect(dependencies.repository.isReplyToPendingConfirmation).not.toHaveBeenCalled();
  });

  it("releases what this call claimed on its failure, and nothing outside the eligible turns", async () => {
    const interjection = createTurnInterjectionCollector(dependencies);

    await interjection.release(toolContext({}));
    expect(dependencies.repository.releaseCall).toHaveBeenCalledWith({ eveSessionId: "ses_1", eveTurnId: "turn_2", toolCallId: "call-1" });

    dependencies.repository.releaseCall.mockClear();
    await interjection.release(toolContext({ telegramTurnInterjectionMarker: undefined }));
    expect(dependencies.repository.releaseCall).not.toHaveBeenCalled();
  });

  it("leaves application commands for their own handler", async () => {
    candidates = [candidate("501", { text: "/start" }), candidate("502", { text: "дальше" })];
    const { collect } = createTurnInterjectionCollector(dependencies);

    expect(blockMessages(await collect(toolContext({})))).toEqual([expect.objectContaining({ text: "дальше" })]);
  });

  it("shows in a family group only the messages addressed to the bot and routes by the group", async () => {
    candidates = [groupCandidate("501", "кто купит хлеб?"), groupCandidate("502", `@${BOT} и молоко тоже`)];
    const { collect } = createTurnInterjectionCollector(dependencies);

    const block = await collect(toolContext(GROUP_ATTRIBUTES));

    expect(blockMessages(block)).toEqual([expect.objectContaining({ text: `@${BOT} и молоко тоже` })]);
    expect(dependencies.repository.routeSessionId).toHaveBeenCalledWith("osinara:group:group-1:main");
    expect(events).toEqual(["release", "claim:502=text", "returned:502"]);
  });

  it("does not let messages it will not show fill the window", async () => {
    candidates = [
      ...Array.from({ length: 12 }, (_, index) => groupCandidate(String(501 + index), `болтовня ${index}`)),
      groupCandidate("600", `@${BOT} стоп`),
    ];
    const { collect } = createTurnInterjectionCollector(dependencies);

    expect(blockMessages(await collect(toolContext(GROUP_ATTRIBUTES)))).toEqual([expect.objectContaining({ text: `@${BOT} стоп` })]);
    expect(dependencies.repository.listCandidates).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it("claims a voice message and marks it started before transcribing it", async () => {
    candidates = [voiceCandidate("501", { voice: { fileId: "voice-501", mimeType: "audio/ogg" } })];
    const { collect } = createTurnInterjectionCollector(dependencies);

    const block = await collect(toolContext({}));

    expect(events).toEqual(["release", "claim:501=voice", "begin:501", "transcribe:voice-501", "returned:501"]);
    expect(dependencies.transcribeVoice).toHaveBeenCalledWith(expect.objectContaining({ fileId: "voice-501", mimeType: "audio/ogg" }));
    expect(dependencies.repository.saveEarlyVoiceTranscript).toHaveBeenCalledWith("501", "и ещё добавь цены");
    expect(blockMessages(block)).toEqual([expect.objectContaining({ kind: "voice", transcript: "и ещё добавь цены" })]);
  });

  it("never pays twice: an existing or already started transcription is not repeated", async () => {
    candidates = [voiceCandidate("501", { voiceTranscript: "готово" }), voiceCandidate("502"), voiceCandidate("503")];
    dependencies.repository.beginEarlyVoiceTranscription
      .mockResolvedValueOnce({ status: "transcribed", transcript: "уже распознано" })
      .mockResolvedValueOnce({ status: "unavailable" });
    const { collect } = createTurnInterjectionCollector(dependencies);

    expect(blockMessages(await collect(toolContext({})))).toEqual([
      expect.objectContaining({ kind: "voice", transcript: "готово" }),
      expect.objectContaining({ kind: "voice", transcript: "уже распознано" }),
      expect.objectContaining({ kind: "voice_unavailable", reason: "transcription_failed" }),
    ]);
    expect(dependencies.transcribeVoice).not.toHaveBeenCalled();
    expect(events).toContain("claim:503=notice");
  });

  it("transcribes at most two recordings per call and leaves the rest waiting", async () => {
    candidates = [voiceCandidate("501"), voiceCandidate("502"), voiceCandidate("503")];
    const { collect } = createTurnInterjectionCollector(dependencies);

    expect(blockMessages(await collect(toolContext({})))).toHaveLength(2);
    expect(events[1]).toBe("claim:501=voice,502=voice");
  });

  it("turns a voice message that cannot be transcribed now into a notice and records that", async () => {
    candidates = [voiceCandidate("501")];
    dependencies.transcribeVoice.mockRejectedValueOnce(new Error("groq unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { collect } = createTurnInterjectionCollector(dependencies);

    const block = await collect(toolContext({}));

    expect(blockMessages(block)).toEqual([expect.objectContaining({ kind: "voice_unavailable", reason: "transcription_failed" })]);
    expect(events).toEqual(["release", "claim:501=voice", "begin:501", "claim:501=notice", "returned:501"]);
  });

  it("does not transcribe voice the sender may not use and shows a notice instead", async () => {
    candidates = [voiceCandidate("501")];
    dependencies.authorizeVoice.mockResolvedValueOnce(false);
    const { collect } = createTurnInterjectionCollector(dependencies);

    expect(blockMessages(await collect(toolContext({})))).toEqual([expect.objectContaining({ kind: "voice_unavailable", reason: "not_transcribed" })]);
    expect(dependencies.transcribeVoice).not.toHaveBeenCalled();
    expect(events).toEqual(["release", "claim:501=notice", "returned:501"]);
  });

  it("releases its claims when anything fails after them", async () => {
    candidates = [candidate("501", { text: "стоп" })];
    dependencies.repository.markReturned.mockRejectedValueOnce(new Error("database unavailable"));
    const { collect } = createTurnInterjectionCollector(dependencies);

    await expect(collect(toolContext({}))).rejects.toThrow("database unavailable");
    expect(events).toEqual(["release", "claim:501=text", "release"]);
  });

  it("announces a photo album with its caption instead of the files themselves", async () => {
    candidates = [candidate("501", {
      caption: "вот чек",
      photo: [{ file_id: "photo-1", file_unique_id: "unique-1", height: 10, width: 10 }],
    }, { albumMemberCount: 2 })];
    const { collect } = createTurnInterjectionCollector(dependencies);

    expect(blockMessages(await collect(toolContext({})))).toEqual([
      expect.objectContaining({ attachment: "photo", caption: "вот чек", count: 3, kind: "attachment" }),
    ]);
    expect(events).toEqual(["release", "claim:501=notice", "returned:501"]);
  });

  it("marks a text longer than the context bound as truncated", async () => {
    candidates = [candidate("501", { text: "а".repeat(5_000) })];
    const { collect } = createTurnInterjectionCollector(dependencies);

    const [message] = blockMessages(await collect(toolContext({})));
    expect(message).toMatchObject({ kind: "text", truncated: true });
    expect(String(message!.text).length).toBeLessThan(5_000);
  });
});
