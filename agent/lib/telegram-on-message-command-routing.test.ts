/**
 * Telegram group command routing tests.
 *
 * Constructs covered:
 * - Unsupported commands remain passive timeline entries and never start an agent turn.
 * - Enrollment command suffixes must target the current bot.
 * - Voice transcripts cannot masquerade as Telegram commands.
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

function familyGroupRepositories() {
  const repository = repositories();
  repository.telegram.findGroup.mockResolvedValue({
    familyId: "family-1",
    groupId: "group-1",
    messageMode: "addressed_only",
    skillAllowlist: [],
    telegramChatId: "group-101",
    toolAllowlist: [],
    type: "family_private",
  });
  return repository;
}

describe("createTelegramMessageHandler command routing", () => {
  it("journals a foreign bot start command instead of consuming it as enrollment", async () => {
    const repository = familyGroupRepositories();
    const handler = createTelegramMessageHandler(repository);
    const message = groupMessage(`/start@other_bot ${"a".repeat(32)}`);

    await expect(handler(telegramContext().context, message)).resolves.toBeNull();

    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-1",
      message,
      expect.objectContaining({ id: "telegram-101", kind: "telegram_user" }),
    );
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it.each<[string, "group" | "supergroup"]>([
    ["/clear 😁", "group"],
    ["/ask", "group"],
    [`/ask@${BOT_USERNAME}`, "group"],
    ["/command@other_bot", "group"],
    ["/clear", "supergroup"],
  ])(
    "journals unsupported slash command %s in a %s without starting an agent turn",
    async (command, chatType) => {
      const repository = familyGroupRepositories();
      repository.journal.record.mockResolvedValue({
        entryId: "00000000-0000-4000-8000-000000000010",
        replyToAgent: true,
        replyTargetUnavailable: false,
        replyToSequenceId: "7",
        sequenceId: "8",
        status: "inserted",
      });
      const handler = createTelegramMessageHandler(repository);
      const { context, sendMessage } = telegramContext();
      const message: TelegramMessage = {
        ...groupMessage(command),
        chat: { id: "group-101", title: "Группа", type: chatType },
        replyToMessage: {
          chat: { id: "group-101", title: "Группа", type: chatType },
          from: {
            firstName: "Osinara",
            id: "bot-1",
            isBot: true,
            username: BOT_USERNAME,
          },
          messageId: "7",
        },
      };

      await expect(handler(context, message)).resolves.toBeNull();

      expect(repository.journal.record).toHaveBeenCalledWith(
        "group-1",
        message,
        expect.objectContaining({ id: "telegram-101", kind: "telegram_user" }),
      );
      expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
      expect(repository.session.hasRoute).not.toHaveBeenCalled();
      expect(repository.session.prepareTurn).not.toHaveBeenCalled();
      expect(repository.groupContext.prepare).not.toHaveBeenCalled();
      expect(repository.hitl.authorizeReply).not.toHaveBeenCalled();
      expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it("does not interpret a command-shaped voice transcript as a Telegram command", async () => {
    const repository = familyGroupRepositories();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    const handler = createTelegramMessageHandler(repository);
    const message: TelegramMessage = {
      ...groupMessage(`/start ${"a".repeat(32)}`),
      caption: `@${BOT_USERNAME} ответь на запись`,
      raw: {
        caption: `@${BOT_USERNAME} ответь на запись`,
        date: 1_700_000_000,
        voice: { file_id: "voice-1" },
      },
    };

    const result = await handler(telegramContext().context, message);

    expect(result?.auth).toBeDefined();
    expect(repository.session.prepareTurn).toHaveBeenCalledTimes(1);
  });
});
