/**
 * Arrival of a private question against an in-memory store and a recording Telegram.
 */
import { describe, expect, it } from "vitest";

import type { FamilyIdentity, RegisteredGroup } from "../family-access.js";
import { createPrivateQuestionArrival, decideArrival } from "./private-question-arrival.js";
import { parsePrivateQuestion } from "./private-question-message.js";
import type { PrivateQuestionChange, PrivateQuestionRow, PrivateQuestionStore } from "./private-question-repository.js";
import type { EphemeralReplyResult, PrivateQuestionTelegram } from "./private-question-telegram.js";
import { PRIVATE_QUESTION_TEXTS } from "./private-question-texts.js";

const SENT_AT = 1_793_982_106;
const NOW = SENT_AT * 1000 + 1_000;

function raw(text = "/me@osinara_bot что решили?", date = SENT_AT) {
  return {
    message: {
      chat: { id: -1001, type: "supergroup" },
      date,
      entities: [{ length: text.split(" ")[0]!.length, offset: 0, type: "bot_command" }],
      ephemeral_message_id: 77,
      from: { first_name: "Ирина", id: 111, is_bot: false },
      message_id: 0,
      text,
    },
    update_id: 500,
  };
}

function group(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    familyId: "family", groupId: "group", messageMode: "all", skillAllowlist: [], telegramChatId: "-1001",
    toolAllowlist: [], type: "external", ...overrides,
  } as RegisteredGroup;
}

const OWNER: FamilyIdentity = { familyId: "family", role: "owner", userId: "owner-user" };

describe("decideArrival", () => {
  const question = parsePrivateQuestion(raw())!;
  const base = { chatType: "supergroup" as const, group: group(), identity: null, nowMs: NOW, phase: "ready", question };

  it("sends «Думаю…» to a participant who may talk to the bot", () => {
    expect(decideArrival(base)).toEqual({ kind: "placeholder" });
  });

  it("lets the window pass silently once Telegram would refuse the reply", () => {
    expect(decideArrival({ ...base, nowMs: SENT_AT * 1000 + 14_001 })).toEqual({ kind: "window_missed" });
  });

  it("tells the person to ask again while a release drains or freezes", () => {
    expect(decideArrival({ ...base, phase: "draining" })).toMatchObject({ kind: "refuse", text: PRIVATE_QUESTION_TEXTS.updating });
  });

  it("answers only the owner where the group answers only the owner", () => {
    const ownerOnly = { ...base, group: group({ messageMode: "owner_only" } as Partial<RegisteredGroup>) };
    expect(decideArrival(ownerOnly)).toMatchObject({ kind: "refuse", text: PRIVATE_QUESTION_TEXTS.ownerOnly });
    expect(decideArrival({ ...ownerOnly, identity: OWNER })).toEqual({ kind: "placeholder" });
  });

  it("refuses a family group to someone outside the family", () => {
    const family = { ...base, group: group({ messageMode: "all", type: "family_private" } as Partial<RegisteredGroup>) };
    expect(decideArrival(family)).toMatchObject({ kind: "refuse", text: PRIVATE_QUESTION_TEXTS.notAllowed });
    expect(decideArrival({ ...family, identity: { ...OWNER, role: "member" } })).toEqual({ kind: "placeholder" });
  });

  it("shows how to ask when the command came alone", () => {
    expect(decideArrival({ ...base, question: parsePrivateQuestion(raw("/me@osinara_bot"))! }))
      .toMatchObject({ kind: "refuse", text: PRIVATE_QUESTION_TEXTS.emptyQuestion });
  });
});

function harness(replies: EphemeralReplyResult[], options: { group?: RegisteredGroup | null; nowMs?: number } = {}) {
  let row: PrivateQuestionRow | null = null;
  const changes: PrivateQuestionChange[] = [];
  const sent: { text: string }[] = [];
  const edits: unknown[] = [];
  const slept: number[] = [];
  let clock = options.nowMs ?? NOW;
  const store = {
    async recordArrival(input) {
      if (row !== null) return;
      row = {
        answer: null, groupId: input.groupId, id: "question", incomingEphemeralMessageId: input.incomingEphemeralMessageId,
        placeholderEphemeralMessageId: null, question: input.question, receivedAt: input.receivedAt, state: "received",
        telegramChatId: input.telegramChatId, telegramUserId: input.telegramUserId, threadId: input.threadId, updateId: input.updateId,
      };
    },
    async withLocked(_updateId, work) {
      if (row === null) return null;
      return await work(row, async (next) => {
        changes.push(next);
        row = {
          ...row!, state: next.state,
          ...(next.state === "placeholder_sent" ? { placeholderEphemeralMessageId: next.placeholderEphemeralMessageId } : {}),
        };
      });
    },
  } as PrivateQuestionStore;
  const telegram: PrivateQuestionTelegram = {
    async reply(input) {
      sent.push({ text: input.text });
      return replies.shift() ?? { ephemeralMessageId: 9, kind: "sent" };
    },
    async edit(input) {
      edits.push(input);
      return { kind: "edited" };
    },
  };
  const arrival = createPrivateQuestionArrival({
    findGroup: async () => options.group === undefined ? group() : options.group,
    findIdentity: async () => null,
    now: () => clock,
    readPhase: async () => "ready",
    sleep: async (milliseconds) => { slept.push(milliseconds); clock += milliseconds; },
    store,
    telegram,
  });
  return { arrival, changes, edits, sent, slept };
}

describe("createPrivateQuestionArrival", () => {
  it("sends one «Думаю…» even when the webhook and the queue both arrive", async () => {
    const { arrival, sent } = harness([]);
    expect(await arrival.arrive(raw(), "500")).toBe("placeholder_sent");
    expect(await arrival.arrive(raw(), "500")).toBe("placeholder_sent");
    expect(sent).toEqual([{ text: PRIVATE_QUESTION_TEXTS.placeholder }]);
  });

  it("waits out a 429 that fits the window and sends once more", async () => {
    const { arrival, sent, slept } = harness([{ kind: "throttled", retryAfterSeconds: 3 }]);
    expect(await arrival.arrive(raw(), "500")).toBe("placeholder_sent");
    expect(slept).toEqual([3000]);
    expect(sent).toHaveLength(2);
  });

  it("gives up on a 429 longer than the window, without a second call", async () => {
    const { arrival, sent } = harness([{ kind: "throttled", retryAfterSeconds: 20 }]);
    expect(await arrival.arrive(raw(), "500")).toBe("window_missed");
    expect(sent).toHaveLength(1);
  });

  it("calls nobody once the window has passed", async () => {
    const { arrival, sent } = harness([], { nowMs: SENT_AT * 1000 + 20_000 });
    expect(await arrival.arrive(raw(), "500")).toBe("window_missed");
    expect(sent).toEqual([]);
  });

  it("records nothing for a group the bot does not work in", async () => {
    const { arrival, sent } = harness([], { group: null });
    expect(await arrival.arrive(raw(), "500")).toBe("ignored");
    expect(sent).toEqual([]);
  });

  it("marks a reply Telegram rejected as failed", async () => {
    const { arrival } = harness([{ description: "Bad Request", kind: "rejected", status: 400 }]);
    expect(await arrival.arrive(raw(), "500")).toBe("failed");
  });

  it("turns «Думаю…» into the failure text when processing breaks", async () => {
    const { arrival, changes, edits } = harness([]);
    await arrival.arrive(raw(), "500");
    await arrival.fail("500", "AGENT_TELEGRAM_INGRESS_FAILED");
    expect(edits).toEqual([{
      chatId: "-1001", content: { text: PRIVATE_QUESTION_TEXTS.failed }, ephemeralMessageId: 9, receiverUserId: "111",
    }]);
    expect(changes.at(-1)).toEqual({ code: "AGENT_TELEGRAM_INGRESS_FAILED", state: "failed" });
  });
});
