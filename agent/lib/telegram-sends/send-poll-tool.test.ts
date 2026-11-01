/**
 * The tool that starts a native Telegram poll.
 *
 * Constructs covered:
 * - The question and each option go as Telegram's poll fields; anonymity and several answers
 *   follow the call, Telegram's defaults otherwise; in a group the poll answers the request.
 * - The sent poll enters the history as the same line the agent reads for a poll it receives.
 * - Too few, too many or repeated options stop before anything is sent.
 */
import type { ToolContext } from "../../runtime/tool.js";
import { describe, expect, it, vi } from "vitest";

import { createSendPollTool } from "../tools/send_poll.js";

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
    callId: "call-poll-1",
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
      id: "wrun-poll",
      turn: { id: "turn-poll", sequence: 1 },
    },
  } as unknown as ToolContext;
}

function dependencies() {
  return { recordTimeline: vi.fn().mockResolvedValue(true), send: vi.fn().mockResolvedValue({ telegramMessageId: "94" }) };
}

async function execute(deps: ReturnType<typeof dependencies>, input: unknown) {
  return await createSendPollTool(deps as never).execute(input as never, context(EXTERNAL_GROUP)) as Record<string, unknown>;
}

describe("send_poll", () => {
  it("starts an open multiple-answer poll as a reply and records it like a received poll", async () => {
    const deps = dependencies();

    const result = await execute(deps, {
      allowsMultipleAnswers: true,
      anonymous: false,
      options: ["кино", "театр", "дома"],
      question: "Куда идём в субботу?",
    });

    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        allows_multiple_answers: true,
        is_anonymous: false,
        options: [{ text: "кино" }, { text: "театр" }, { text: "дома" }],
        question: "Куда идём в субботу?",
      },
      method: "sendPoll",
      target: { chatId: "-1002", replyToMessageId: 52 },
    }));
    expect(deps.recordTimeline).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      contentText: "📊 Опрос «Куда идём в субботу?»: кино / театр / дома (открытый, можно несколько)",
    }));
    expect(result).toMatchObject({ delivered: true, sideEffectStatus: "completed", telegramMessageId: "94" });
  });

  it("leaves anonymity and single choice to Telegram's defaults when the call does not set them", async () => {
    const deps = dependencies();

    await execute(deps, { options: ["да", "нет"], question: "Едем?" });

    expect(deps.send.mock.calls[0]![0].body).toEqual({ options: [{ text: "да" }, { text: "нет" }], question: "Едем?" });
    expect(deps.recordTimeline.mock.calls[0]![2].contentText).toBe("📊 Опрос «Едем?»: да / нет (анонимный)");
  });

  it.each([
    ["one option", { options: ["да"], question: "Едем?" }],
    ["thirteen options", { options: Array.from({ length: 13 }, (_, index) => `вариант ${index}`), question: "Что?" }],
    ["a repeated option", { options: ["Кино", "кино "], question: "Куда?" }],
    ["an over-long question", { options: ["да", "нет"], question: "?".repeat(301) }],
  ])("refuses %s before sending anything", async (_name, input) => {
    const deps = dependencies();

    await expect(execute(deps, input)).rejects.toMatchObject({
      contract: { category: "input", code: "AGENT_POLL_SEND_INPUT_INVALID", sideEffectStatus: "not_started" },
    });
    expect(deps.send).not.toHaveBeenCalled();
  });
});
