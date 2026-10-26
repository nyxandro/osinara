/**
 * Telegram bot-participant routing boundary tests.
 *
 * Constructs covered:
 * - An external group admits another bot as a group-scoped participant without any account.
 * - A bot reaches the model under exactly the rules that apply to a human participant.
 * - The trusted family zone drops a bot before the shared timeline is written.
 * - Owner-only mode never accepts a bot, because it is reserved for the verified human owner.
 * - A bot reply to Osinara stays an ordinary message and never enters HITL approval.
 * - A natively formatted rich message is read like any other text, including its mention.
 * - A private message from a bot is dropped silently, without an enrollment hint to answer.
 */
import { describe, expect, it } from "vitest";

import {
  BOT_USERNAME,
  botGroupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

const externalGroup = {
  familyId: "family-1",
  groupId: "group-2",
  messageMode: "all" as const,
  skillAllowlist: [],
  telegramChatId: "group-101",
  toolAllowlist: [],
  type: "external" as const,
};

describe("createTelegramMessageHandler bot senders", () => {
  it("dispatches an addressed bot message as a group-scoped participant", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(externalGroup);
    const handler = createTelegramMessageHandler(repository);
    const { context } = telegramContext();

    const result = await handler(context, botGroupMessage(`@${BOT_USERNAME} привет`));

    expect(result?.auth).toMatchObject({
      attributes: {
        groupId: "group-2",
        groupType: "external",
        memoryScopes: ["group"],
        role: "external",
        telegramActorId: "8123456789",
        telegramActorKind: "telegram_bot",
        telegramUserId: "8123456789",
      },
      principalId: "telegram-bot:8123456789",
      principalType: "service",
    });
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("reads a rich formatted bot message and reacts to the mention inside it", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(externalGroup);
    const handler = createTelegramMessageHandler(repository);
    const { context } = telegramContext();
    const message = {
      ...botGroupMessage(""),
      raw: {
        date: 1_700_000_000,
        from: { first_name: "Мия", id: 8_123_456_789, is_bot: true, username: "mimimia_ai_bot" },
        rich_message: {
          blocks: [{
            text: [{ text: `@${BOT_USERNAME}`, type: "mention" }, " смотри что нашла"],
            type: "paragraph",
          }],
        },
      },
      text: "",
    };

    const result = await handler(context, message);

    expect(result?.auth).toMatchObject({ attributes: { telegramActorKind: "telegram_bot" } });
  });

  it("journals an unaddressed bot message without waking the model", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(externalGroup);
    const handler = createTelegramMessageHandler(repository);
    const { context } = telegramContext();

    const result = await handler(context, botGroupMessage("просто болтаю в чате"));

    expect(result).toBeNull();
    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-2",
      expect.anything(),
      expect.objectContaining({ actorId: "telegram-bot:8123456789", kind: "telegram_bot" }),
    );
    // A bot's message enters memory review exactly like a person's.
    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledWith({
      groupId: "group-2",
      timelineEntryId: "00000000-0000-4000-8000-000000000010",
    });
  });

  it("treats a bot reply to Osinara as a message, never as HITL approval", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(externalGroup);
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000010",
      replyToAgent: true,
      replyTargetUnavailable: false,
      replyToSequenceId: "99",
      sequenceId: "100",
      status: "inserted",
    });
    const message = {
      ...botGroupMessage("и тебе привет"),
      replyToMessage: {
        chat: { id: "group-101", type: "group" as const },
        from: { firstName: "Осинара", id: "bot-1", isBot: true, username: BOT_USERNAME },
        messageId: "99",
      },
    };

    const result = await createTelegramMessageHandler(repository)(telegramContext().context, message);

    expect(repository.hitl.authorizeReply).not.toHaveBeenCalled();
    expect(result?.auth?.principalType).toBe("service");
  });

  it("drops a bot message in the trusted family zone before journaling it", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      ...externalGroup,
      groupId: "group-1",
      type: "family_private",
    });
    const handler = createTelegramMessageHandler(repository);
    const { context } = telegramContext();

    const result = await handler(context, botGroupMessage(`@${BOT_USERNAME} привет`));

    expect(result).toBeNull();
    expect(repository.journal.record).not.toHaveBeenCalled();
  });

  it("answers nothing to a bot in a private chat", async () => {
    const repository = repositories();
    const handler = createTelegramMessageHandler(repository);
    const { context, sendMessage } = telegramContext();
    const message = {
      ...botGroupMessage("привет"),
      chat: { id: "8123456789", type: "private" as const },
    };

    const result = await handler(context, message);

    expect(result).toBeNull();
    // An enrollment hint would be answered by the other bot, and answered again on every reply.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("drops a bot message in an owner-only external group", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      ...externalGroup,
      messageMode: "owner_only",
    });
    const handler = createTelegramMessageHandler(repository);
    const { context } = telegramContext();

    const result = await handler(context, botGroupMessage(`@${BOT_USERNAME} привет`));

    expect(result).toBeNull();
    expect(repository.journal.record).not.toHaveBeenCalled();
  });
});
