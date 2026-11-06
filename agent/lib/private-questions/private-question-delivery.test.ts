/**
 * The end of a private question's turn: what replaces «Думаю…» and nothing else.
 */
import { describe, expect, it, vi } from "vitest";

import type { TurnRecord } from "../../runtime/turn/turn-types.js";
import { createPrivateQuestionObserver, privateAnswerContent } from "./private-question-delivery.js";
import type { PrivateQuestionChange, PrivateQuestionRow } from "./private-question-repository.js";
import type { EphemeralEditResult, PrivateQuestionTelegram } from "./private-question-telegram.js";
import { PRIVATE_QUESTION_TEXTS } from "./private-question-texts.js";

const ROW: PrivateQuestionRow = {
  answer: null, groupId: "group", id: "question-1", incomingEphemeralMessageId: 77, placeholderEphemeralMessageId: 9,
  question: "что решили?", receivedAt: new Date("2026-11-06T16:00:00Z"), state: "answering", telegramChatId: "-1001",
  telegramUserId: "111", threadId: null, updateId: "500",
};

const TURN = {
  auth: { current: { attributes: { applicationSessionId: "app-1", privateQuestionId: "question-1" } }, initiator: null },
  id: "turn_1", sessionId: "session-1",
} as unknown as TurnRecord;

function harness(editResult: EphemeralEditResult = { kind: "edited" }) {
  const edits: unknown[] = [];
  const replies: unknown[] = [];
  const changes: PrivateQuestionChange[] = [];
  const sessionTurns: string[] = [];
  const telegram: PrivateQuestionTelegram = {
    async edit(input) {
      edits.push(input);
      return editResult;
    },
    async reply(input) {
      replies.push(input);
      return { ephemeralMessageId: 1, kind: "sent" };
    },
  };
  const observer = createPrivateQuestionObserver({
    bindApplicationSession: vi.fn(async () => undefined),
    async recordSessionTurn(_applicationSessionId, _agentSessionId, outcome) {
      sessionTurns.push(outcome);
    },
    store: {
      async changeById(_id, next) {
        changes.push(next);
      },
      findById: async () => ROW,
    },
    telegram,
  });
  return { changes, edits, observer, replies, sessionTurns };
}

describe("privateAnswerContent", () => {
  it("joins the model's split points into one message", () => {
    const answer = privateAnswerContent("Первое.\n[[split]]\nВторое.");
    expect(answer.kind).toBe("answer");
    expect(answer.kind === "answer" ? answer.markdown : "").toContain("Первое.");
    expect(answer.kind === "answer" ? answer.markdown : "").toContain("Второе.");
  });

  it("treats silence and a reaction alone as no answer", () => {
    expect(privateAnswerContent(null)).toEqual({ kind: "empty" });
    expect(privateAnswerContent("<telegram-reaction>👍</telegram-reaction>")).toEqual({ kind: "empty" });
  });

  it("refuses an answer longer than one message instead of cutting it", () => {
    expect(privateAnswerContent("слово ".repeat(10_000))).toEqual({ kind: "too_long" });
    const paragraphs = Array.from({ length: 400 }, (_, index) => `Абзац ${index}: ${"текст ".repeat(30)}`).join("\n\n");
    expect(privateAnswerContent(paragraphs)).toEqual({ kind: "too_long" });
  });
});

describe("createPrivateQuestionObserver", () => {
  it("puts the answer in place of «Думаю…» and sends nothing else", async () => {
    const { changes, edits, observer, replies, sessionTurns } = harness();
    await observer.turnFinished({ outcome: { status: "completed", text: "Решили сдвинуть релиз на пятницу." }, turn: TURN });
    expect(edits).toEqual([{
      chatId: "-1001",
      content: { markdown: "Решили сдвинуть релиз на пятницу." },
      ephemeralMessageId: 9,
      receiverUserId: "111",
    }]);
    expect(replies).toEqual([]);
    expect(changes).toEqual([{ answer: "Решили сдвинуть релиз на пятницу.", state: "answered" }]);
    expect(sessionTurns).toEqual(["completed"]);
  });

  it("shows the failure text when the turn fails, and a separate one when the model is unavailable", async () => {
    const failed = harness();
    await failed.observer.turnFinished({ outcome: { code: "AGENT_SOMETHING", message: "x", status: "failed" }, turn: TURN });
    expect(failed.edits).toEqual([expect.objectContaining({ content: { text: PRIVATE_QUESTION_TEXTS.failed } })]);
    expect(failed.changes).toEqual([{ code: "AGENT_PRIVATE_QUESTION_FAILED", state: "failed" }]);

    const unavailable = harness();
    await unavailable.observer.turnFinished({
      outcome: { code: "AGENT_MODEL_TEMPORARILY_UNAVAILABLE", message: "x", status: "failed" }, turn: TURN,
    });
    expect(unavailable.edits).toEqual([expect.objectContaining({ content: { text: PRIVATE_QUESTION_TEXTS.modelUnavailable } })]);
  });

  it("tells the person the answer was cancelled", async () => {
    const { changes, edits, observer } = harness();
    await observer.turnFinished({ outcome: { status: "cancelled" }, turn: TURN });
    expect(edits).toEqual([expect.objectContaining({ content: { text: PRIVATE_QUESTION_TEXTS.cancelled } })]);
    expect(changes).toEqual([{ code: "AGENT_PRIVATE_QUESTION_CANCELLED", state: "cancelled" }]);
  });

  it("answers silence with a plain text instead of leaving «Думаю…»", async () => {
    const { changes, edits, observer } = harness();
    await observer.turnFinished({ outcome: { status: "completed", text: null }, turn: TURN });
    expect(edits).toEqual([expect.objectContaining({ content: { text: PRIVATE_QUESTION_TEXTS.emptyAnswer } })]);
    expect(changes).toEqual([{ code: "AGENT_PRIVATE_ANSWER_EMPTY", state: "failed" }]);
  });

  it("shows the failure text when Telegram refuses the answer", async () => {
    const { changes, edits, observer } = harness({ description: "Bad Request: can't parse", kind: "rejected", status: 400 });
    await observer.turnFinished({ outcome: { status: "completed", text: "Ответ" }, turn: TURN });
    expect(edits).toHaveLength(2);
    expect(edits[1]).toEqual(expect.objectContaining({ content: { text: PRIVATE_QUESTION_TEXTS.failed } }));
    expect(changes).toEqual([{ code: "AGENT_PRIVATE_ANSWER_REJECTED", state: "failed" }]);
  });

  it("refuses a request for a person: nobody can confirm in a private question", async () => {
    const { observer } = harness();
    await expect(observer.inputRequested({ requests: [], stepIndex: 0, turn: TURN }))
      .rejects.toMatchObject({ code: "AGENT_PRIVATE_QUESTION_INPUT_UNAVAILABLE" });
  });
});
