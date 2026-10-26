/**
 * A press through the ordinary inbound boundary.
 *
 * Constructs covered:
 * - A private press lands in the chat's main conversation, not in a separate reply branch.
 * - A group press is a reply to the agent's message and so addresses the agent there.
 */
import { describe, expect, it, vi } from "vitest";

import { parseTelegramUpdate } from "../../runtime/telegram/inbound.js";
import { createTelegramMessageHandler } from "../telegram-on-message.js";
import { BOT_USERNAME, repositories, telegramContext } from "../telegram-on-message.test-fixtures.js";
import { createReplyButtonPressHandler } from "./reply-button-press.js";
import type { ReplyButtonSet } from "./reply-button-repository.js";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

async function pressedMessage(chat: Record<string, unknown>, chatType: ReplyButtonSet["telegramChatType"]) {
  const update = parseTelegramUpdate({
    callback_query: {
      data: `rb:${TOKEN}:0`,
      from: { first_name: "Анна", id: "telegram-101", is_bot: false, username: "anna" },
      id: "cb-1",
      message: { chat, date: 1_700_000_000, from: { first_name: "Osinara", id: 999, is_bot: true, username: BOT_USERNAME },
        message_id: 88, text: "Оформляем?" },
    },
    update_id: 9001,
  });
  if (update?.kind !== "callback_query") throw new Error("TEST_CALLBACK_INVALID");
  const set: ReplyButtonSet = {
    addresseeTelegramUserId: "telegram-101", buttons: [[{ text: "✅ Да" }]], id: "set-1",
    messageText: "Оформляем?", resolvedAt: new Date(1_700_000_010_000), selectedIndex: 0, status: "selected",
    telegramChatId: String(chat.id), telegramChatType: chatType, telegramMessageId: "88", token: TOKEN,
  };
  const { continueAsMessage: handle } = createReplyButtonPressHandler({
    repository: {
      claimPress: vi.fn().mockResolvedValue({ set, status: "replayed" }),
      replyRouteIsOpen: vi.fn().mockResolvedValue(false),
    },
    telegram: { answerPress: vi.fn(), settle: vi.fn() },
  });
  const outcome = await handle(update.callbackQuery, "9001");
  if (outcome.status !== "message") throw new Error("TEST_EXPECTED_MESSAGE");
  return outcome.message;
}

describe("a reply-button press at the inbound boundary", () => {
  it("lands a private press in the chat's main conversation", async () => {
    const repository = repositories();
    repository.telegram.findIdentity.mockResolvedValue({ familyId: "family-1", role: "owner", userId: "user-1" });
    const message = await pressedMessage({ id: "telegram-101", type: "private" }, "private");

    const result = await createTelegramMessageHandler(repository)(telegramContext().context, message);

    expect(result).not.toBeNull();
    expect(repository.hitl.authorizeReply).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({ baseContinuationToken: "telegram-101::" }));
  });

  it("addresses a group press to the agent as a reply to its message", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1", groupId: "group-1", messageMode: "addressed_only", skillAllowlist: [],
      telegramChatId: "group-101", toolAllowlist: [], type: "family_private",
    });
    repository.telegram.findIdentity.mockResolvedValue({ familyId: "family-1", role: "member", userId: "user-1" });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000400", replyToAgent: true, sequenceId: "400", status: "inserted",
    });
    repository.hitl.authorizeReply.mockResolvedValue("not_applicable");
    const message = await pressedMessage({ id: "group-101", title: "Семья", type: "group" }, "group");

    const result = await createTelegramMessageHandler(repository)(telegramContext().context, message);

    expect(repository.journal.record).toHaveBeenCalledWith("group-1", expect.objectContaining({
      replyToMessage: expect.objectContaining({ messageId: "88" }),
      text: "[Tapped button «✅ Да» under your message: «Оформляем?»]",
    }), expect.anything());
    expect(result?.auth?.attributes).toMatchObject({ telegramGroupTurnTrigger: "reply_to_agent" });
  });
});
