/**
 * Recognition of an ephemeral `/me` command. The update shape is the one the production bot received on
 * 2026-11-06 (identifiers replaced).
 */
import { describe, expect, it } from "vitest";

import { isEphemeralGroupMessage, parsePrivateQuestion } from "./private-question-message.js";

function update(text: string, overrides: Record<string, unknown> = {}) {
  const commandLength = text.split(" ")[0]!.length;
  return {
    message: {
      chat: { id: -1001234, title: "Чат", type: "supergroup" },
      date: 1_793_982_106,
      entities: [{ length: commandLength, offset: 0, type: "bot_command" }],
      ephemeral_message_id: 204_858_069,
      from: { first_name: "Ирина", id: 111, is_bot: false },
      message_id: 0,
      receiver_user: { first_name: "Бот", id: 999, is_bot: true },
      text,
      ...overrides,
    },
    update_id: 57_118_685,
  };
}

describe("parsePrivateQuestion", () => {
  it("takes the question after the command the menu inserts with the bot's name", () => {
    expect(parsePrivateQuestion(update("/me@osinara_bot что решили по срокам?"))).toEqual({
      chatId: "-1001234",
      command: "me",
      firstName: "Ирина",
      incomingEphemeralMessageId: 204_858_069,
      question: "что решили по срокам?",
      sentAt: 1_793_982_106,
      telegramUserId: "111",
      threadId: null,
    });
  });

  it("reads a command typed without the bot's name the same way", () => {
    expect(parsePrivateQuestion(update("/me что решили?"))?.question).toBe("что решили?");
  });

  it("keeps an empty question for the bare command", () => {
    expect(parsePrivateQuestion(update("/me@osinara_bot"))?.question).toBe("");
  });

  it("keeps the topic only for an explicit topic message", () => {
    expect(parsePrivateQuestion(update("/me вопрос", { is_topic_message: true, message_thread_id: 7 }))?.threadId).toBe(7);
    expect(parsePrivateQuestion(update("/me вопрос", { message_thread_id: 7 }))?.threadId).toBeNull();
  });

  it("ignores an ordinary group message and a public slash command", () => {
    const ordinary = update("/me вопрос");
    delete (ordinary.message as Record<string, unknown>).ephemeral_message_id;
    expect(parsePrivateQuestion(ordinary)).toBeNull();
    expect(isEphemeralGroupMessage(ordinary)).toBe(false);
  });

  it("refuses what a bot sent, and an update without a date", () => {
    expect(parsePrivateQuestion(update("/me вопрос", { from: { id: 5, is_bot: true } }))).toBeNull();
    expect(parsePrivateQuestion(update("/me вопрос", { date: undefined }))).toBeNull();
  });

  it("does not treat a private chat as a group", () => {
    const privateChat = update("/me вопрос", { chat: { id: 111, type: "private" } });
    expect(isEphemeralGroupMessage(privateChat)).toBe(false);
    expect(parsePrivateQuestion(privateChat)).toBeNull();
  });

  it("still marks an ephemeral message without a leading command as ephemeral", () => {
    const plain = update("просто текст", { entities: [] });
    expect(isEphemeralGroupMessage(plain)).toBe(true);
    expect(parsePrivateQuestion(plain)).toBeNull();
  });
});
