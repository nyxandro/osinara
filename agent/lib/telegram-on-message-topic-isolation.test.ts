/**
 * Telegram group journal topic-isolation regressions.
 *
 * Constructs covered:
 * - Ordinary supergroup reply threads share the main group journal.
 * - Verified forum topics retain isolated journal reads.
 * - Eve delivery routing keeps the original Telegram thread in both cases.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { describe, expect, it } from "vitest";

import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

function registeredRepositories() {
  const repository = repositories();
  repository.telegram.findGroup.mockResolvedValue({
    familyId: "family-1",
    groupId: "group-1",
    messageMode: "all",
    skillAllowlist: [],
    telegramChatId: "group-101",
    toolAllowlist: [],
    type: "family_private",
  });
  repository.telegram.findIdentity.mockResolvedValue({
    familyId: "family-1",
    role: "owner",
    userId: "user-1",
  });
  return repository;
}

function addressedThreadMessage(isTopicMessage?: boolean): TelegramMessage {
  const base = groupMessage(`@${BOT_USERNAME} что было перед этим?`);
  return {
    ...base,
    chat: { ...base.chat, type: "supergroup" },
    messageId: "317",
    messageThreadId: 310,
    raw: {
      ...base.raw,
      ...(isTopicMessage === undefined ? {} : { is_topic_message: isTopicMessage }),
    },
  };
}

describe("Telegram group journal topic isolation", () => {
  it("accepts a reply to any agent chunk through the trusted timeline alias", async () => {
    const repository = registeredRepositories();
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000020",
      replyToAgent: true,
      sequenceId: "20",
      status: "inserted",
    });
    const base = groupMessage("продолжи");
    const message: TelegramMessage = {
      ...base,
      replyToMessage: {
        chat: base.chat,
        from: { id: "bot", isBot: true },
        messageId: "19",
      },
    };

    const result = await createTelegramMessageHandler(repository)(telegramContext().context, message);

    expect(repository.session.hasRoute).toHaveBeenCalled();
    expect(result?.auth).not.toBeNull();
  });

  it("reads the main journal for an ordinary reply thread without changing delivery routing", async () => {
    const repository = registeredRepositories();
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, addressedThreadMessage());

    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({
      messageThreadId: null,
    }));
    expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "osinara:group:group-1:main",
      telegramForumTopicId: null,
    }));
    expect(result?.auth?.attributes).toMatchObject({ telegramMessageThreadId: "310" });
  });

  it("reads only the verified forum topic while preserving its delivery route", async () => {
    const repository = registeredRepositories();
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, addressedThreadMessage(true));

    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({
      messageThreadId: "310",
    }));
    expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "osinara:group:group-1:topic:310",
      telegramForumTopicId: 310,
    }));
    expect(result?.auth?.attributes).toMatchObject({ telegramMessageThreadId: "310" });
  });
});
