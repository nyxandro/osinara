/**
 * Model-facing GIF reply tool tests.
 *
 * Constructs covered:
 * - The content filter follows the conversation kind: the family group gets the strictest level.
 * - The search runs under the "choosing a sticker" status; the picked GIF is sent unchanged, as a
 *   reply in a group, and recorded in the history as the answer it stands for.
 * - Finding nothing sends nothing and tells the model how to answer instead.
 * - Invalid input stops before the search; an unconfirmed delivery is reported as possibly
 *   delivered; any other failure forbids another attempt in the turn.
 * - The call is never replayed after a crash: an interrupted send has an unknown outcome.
 */
import type { ToolContext } from "../../runtime/tool.js";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import { EMPTY_DELIVERY_MARKER } from "../../runtime/turn/step-history.js";
import { createSendGifTool } from "../tools/send_gif.js";
import type { GifReplySearchResult } from "./gif-reply-search.js";

const PICKED: GifReplySearchResult = {
  description: "робот показывает средний палец",
  gif: {
    height: 480,
    previewUrl: "https://static.klipy.com/ii/robot/sm.webp",
    sendUrl: "https://static.klipy.com/ii/robot/hd.mp4",
    slug: "robot-middle-finger",
    title: "Robot Middle Finger",
    width: 480,
  },
  outcome: "picked",
  sheetsShown: 1,
};

const INPUT = {
  brief: "дерзкий ответ на «ну ты и тупая», грубый жест допустим",
  query: "middle finger",
};

const PRIVATE = { telegramChatId: "101", telegramChatType: "private" };
const FAMILY_GROUP = {
  groupId: "group-1",
  groupType: "family_private",
  telegramChatId: "-1001",
  telegramChatType: "supergroup",
  telegramForumTopicId: "7",
  telegramMessageThreadId: "7",
  telegramReplyToMessageId: "41",
};
const EXTERNAL_GROUP = {
  groupId: "group-2",
  groupType: "external",
  role: "external",
  telegramChatId: "-1002",
  telegramChatType: "supergroup",
  telegramReplyToMessageId: "52",
};

function context(attributes: Record<string, string>): ToolContext {
  return {
    callId: "call-gif-1",
    session: {
      auth: {
        current: {
          attributes: { familyId: "family-1", role: "owner", ...attributes },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "wrun-gif",
      turn: { id: "turn-gif", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function dependencies(result: GifReplySearchResult | Error = PICKED) {
  return {
    choosingStatus: vi.fn(async (_target: unknown, operation: () => Promise<unknown>) => await operation()),
    find: result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result),
    recordTimeline: vi.fn().mockResolvedValue(true),
    send: vi.fn().mockResolvedValue({ telegramMessageId: "93" }),
  };
}

async function execute(deps: ReturnType<typeof dependencies>, attributes: Record<string, string>, input: unknown = INPUT) {
  return await createSendGifTool(deps as never).execute(input as never, context(attributes)) as Record<string, unknown>;
}

describe("send_gif", () => {
  it("finds a GIF under the choosing status and sends it unchanged in a private chat", async () => {
    const deps = dependencies();

    const result = await execute(deps, PRIVATE);

    expect(deps.choosingStatus).toHaveBeenCalledWith({ chatId: "101" }, expect.any(Function));
    expect(deps.find).toHaveBeenCalledWith(expect.objectContaining({ ...INPUT, contentFilter: "medium" }));
    expect(deps.send).toHaveBeenCalledWith({
      chatId: "101",
      height: 480,
      url: "https://static.klipy.com/ii/robot/hd.mp4",
      width: 480,
    });
    expect(deps.recordTimeline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ groupId: null }), {
      contentText: "Гифка: робот показывает средний палец",
      failureCode: "AGENT_GIF_PROJECTION_FAILED",
      replacesAnswer: true,
      telegramMessageId: "93",
    });
    expect(result).toMatchObject({
      delivered: true,
      description: "робот показывает средний палец",
      sideEffectStatus: "completed",
      telegramMessageId: "93",
    });
    expect(result.nextStep).toContain(EMPTY_DELIVERY_MARKER);
  });

  it("uses the strictest filter in the family group and answers the message in its topic", async () => {
    const deps = dependencies();

    await execute(deps, FAMILY_GROUP, { ...INPUT, caption: "сама такая" });

    expect(deps.find).toHaveBeenCalledWith(expect.objectContaining({ contentFilter: "high" }));
    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({
      caption: "сама такая",
      chatId: "-1001",
      messageThreadId: 7,
      replyToMessageId: 41,
    }));
    expect(deps.recordTimeline.mock.calls[0]![2]).toMatchObject({
      contentText: "Гифка: робот показывает средний палец\n\nПодпись: сама такая",
    });
  });

  it("uses the agreed filter in an external group", async () => {
    const deps = dependencies();

    await execute(deps, EXTERNAL_GROUP);

    expect(deps.find).toHaveBeenCalledWith(expect.objectContaining({ contentFilter: "medium" }));
    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({ chatId: "-1002", replyToMessageId: 52 }));
  });

  it.each([
    [{ outcome: "no_results" }],
    [{ outcome: "no_suitable_gif", sheetsShown: 3 }],
  ] as const)("sends nothing when the search ends with %o", async (found) => {
    const deps = dependencies(found);

    const result = await execute(deps, PRIVATE);

    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.recordTimeline).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: false, outcome: found.outcome, sideEffectStatus: "not_started" });
    expect(typeof result.nextStep).toBe("string");
  });

  it.each([
    ["an empty query", { ...INPUT, query: " " }],
    ["an unknown field", { ...INPUT, scope: "personal" }],
    ["a caption over Telegram's limit", { ...INPUT, caption: "а".repeat(1_025) }],
  ])("stops %s before the search", async (_label, input) => {
    const deps = dependencies();

    await expect(execute(deps, PRIVATE, input)).rejects.toMatchObject({
      contract: { category: "input", code: "AGENT_GIF_REPLY_INPUT_INVALID", retryable: true },
    });
    expect(deps.find).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed delivery as possibly delivered", async () => {
    const deps = dependencies();
    deps.send.mockRejectedValue(new AppError("AGENT_GIF_DELIVERY_AMBIGUOUS", "Не удалось подтвердить отправку гифки"));

    const failure = await execute(deps, PRIVATE).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModelFacingError);
    expect((failure as ModelFacingError).contract).toMatchObject({
      code: "AGENT_GIF_DELIVERY_AMBIGUOUS",
      retryable: false,
      sideEffectStatus: "unknown",
    });
  });

  it("forbids another attempt after a search failure", async () => {
    const deps = dependencies(new AppError("AGENT_GIF_SEARCH_RATE_LIMITED", "Лимит поиска гифок исчерпан на ближайший час"));

    const failure = await execute(deps, PRIVATE).catch((error: unknown) => error);

    expect((failure as ModelFacingError).contract).toMatchObject({
      code: "AGENT_GIF_SEARCH_RATE_LIMITED",
      reason: "Лимит поиска гифок исчерпан на ближайший час",
      retryable: false,
      sideEffectStatus: "not_started",
    });
    expect((failure as ModelFacingError).contract.correction).toContain("send_gif");
  });

  it("is never replayed after a crash", () => {
    expect(createSendGifTool(dependencies() as never).replaySafe).not.toBe(true);
  });
});
