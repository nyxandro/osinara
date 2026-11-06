/**
 * Starting a private question's turn: rights checked again, one turn per question, what the model sees.
 */
import { describe, expect, it, vi } from "vitest";

import type { RegisteredGroup } from "../family-access.js";
import type { PrivateQuestionChange, PrivateQuestionRow } from "./private-question-repository.js";
import { createPrivateQuestionTurns, privateQuestionToken, type PrivateQuestionTurnDependencies } from "./private-question-turn.js";

const NOW = new Date("2026-11-06T16:00:00Z");
const ROW: PrivateQuestionRow = {
  answer: null, groupId: "group", id: "q-1", incomingEphemeralMessageId: 77, placeholderEphemeralMessageId: 9,
  question: "а подробнее?", receivedAt: NOW, state: "placeholder_sent", telegramChatId: "-1001", telegramUserId: "111",
  threadId: null, updateId: "500",
};
const GROUP = {
  familyId: "family", groupId: "group", messageMode: "all", skillAllowlist: ["pdf"], telegramChatId: "-1001",
  toolAllowlist: ["search_memories"], type: "external",
} as RegisteredGroup;

function harness(overrides: Partial<PrivateQuestionTurnDependencies> = {}) {
  const changes: PrivateQuestionChange[] = [];
  const started: Parameters<PrivateQuestionTurnDependencies["startTurn"]>[0][] = [];
  const recent = vi.fn(async () => [{ answer: "Решили сдвинуть релиз.", question: "что решили?", receivedAt: new Date("2026-11-06T15:50:00Z") }]);
  const dependencies: PrivateQuestionTurnDependencies = {
    conversationId: async () => "conversation-1",
    findGroup: async () => GROUP,
    findIdentity: async () => null,
    findStartedTurn: async () => null,
    lastNewContextAt: async () => new Date("2026-11-06T10:00:00Z"),
    now: () => NOW,
    prepareSession: vi.fn(async () => ({ continuationToken: "t", generation: 0, id: "app-1", rotated: false, sandboxSessionId: "sb-1" })),
    runTurn: vi.fn(async () => ({ status: "completed" as const, text: "ok" })),
    async startTurn(input) {
      started.push(input);
      return { sessionId: "session-1", turnId: "turn_1" };
    },
    store: {
      async changeById(_id, next) {
        changes.push(next);
      },
      recentExchanges: recent,
    },
    timeline: async () => "<untrusted_telegram_group_timeline>\n#1 [Павел] сроки сдвигаем\n</untrusted_telegram_group_timeline>",
    ...overrides,
  };
  return { changes, dependencies, recent, run: createPrivateQuestionTurns(dependencies), started };
}

describe("createPrivateQuestionTurns", () => {
  it("starts one turn in its own channel session with the group's rights and the private flag", async () => {
    const { changes, dependencies, run, started } = harness();
    expect(await run(ROW, { chatType: "supergroup", name: "Ирина" })).toEqual({ sessionId: "session-1" });
    expect(changes).toEqual([{ state: "answering" }]);
    expect(dependencies.prepareSession).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: privateQuestionToken("q-1"), groupId: "group", kind: "scheduled", scope: "group",
    }));
    const turn = started[0]!;
    expect(turn.token).toBe("private-question:q-1");
    expect(turn.auth.attributes).toMatchObject({
      groupType: "external", privateQuestion: "true", privateQuestionId: "q-1", privateQuestionSenderName: "Ирина",
      role: "external", skillAllowlist: [], telegramConversationId: "conversation-1", telegramUserId: "111",
      toolAllowlist: ["search_memories"],
    });
    // The memory selection searches by the message: only the question goes there.
    expect(turn.message).toBe('<private_question>\n{"senderDisplayName":"Ирина","text":"а подробнее?"}\n</private_question>');
    expect(turn.context.join("\n")).toContain("<untrusted_telegram_group_timeline>");
    expect(turn.context.join("\n")).toContain("<untrusted_previous_private_exchanges>");
    expect(turn.context.join("\n")).toContain("Решили сдвинуть релиз.");
    expect(dependencies.runTurn).toHaveBeenCalledWith("turn_1");
  });

  it("takes earlier exchanges only from after the group's last new context, and from no older than a day", async () => {
    const { recent, run } = harness();
    await run(ROW, { chatType: "supergroup", name: "Ирина" });
    expect(recent).toHaveBeenCalledWith(expect.objectContaining({
      excludeId: "q-1", since: new Date("2026-11-06T10:00:00Z"), telegramUserId: "111", threadId: null,
    }));
    const old = harness({ lastNewContextAt: async () => new Date("2026-11-01T10:00:00Z") });
    await old.run(ROW, { chatType: "supergroup", name: "Ирина" });
    expect(old.recent).toHaveBeenCalledWith(expect.objectContaining({ since: new Date("2026-11-05T16:00:00Z") }));
  });

  it("finishes the turn a previous attempt started instead of starting a second one", async () => {
    const { dependencies, run, started } = harness({ findStartedTurn: async () => ({ sessionId: "session-0", turnId: "turn_0" }) });
    expect(await run(ROW, { chatType: "supergroup", name: "Ирина" })).toEqual({ sessionId: "session-0" });
    expect(started).toEqual([]);
    expect(dependencies.runTurn).toHaveBeenCalledWith("turn_0");
  });

  it("starts nothing when the group is gone or answers only the owner now", async () => {
    const gone = harness({ findGroup: async () => null });
    expect(await gone.run(ROW, { chatType: "supergroup", name: "Ирина" })).toEqual({ refused: "AGENT_PRIVATE_QUESTION_NOT_ALLOWED" });
    expect(gone.started).toEqual([]);
    const ownerOnly = harness({ findGroup: async () => ({ ...GROUP, messageMode: "owner_only" }) as RegisteredGroup });
    expect(await ownerOnly.run(ROW, { chatType: "supergroup", name: "Ирина" })).toEqual({ refused: "AGENT_PRIVATE_QUESTION_NOT_ALLOWED" });
    expect(ownerOnly.changes).toEqual([{ code: "AGENT_PRIVATE_QUESTION_NOT_ALLOWED", state: "refused" }]);
  });
});
