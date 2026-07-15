/**
 * Telegram group reply routing regression tests.
 *
 * Constructs covered:
 * - Username-less replies to prior Osinara bot messages continue via persisted session routes.
 * - Replies to unknown bot messages stay ignored, so other bots cannot trigger Osinara turns.
 */
import { describe, expect, it } from "vitest";

import {
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

function familyGroupRepository() {
  const repository = repositories();
  repository.telegram.findGroup.mockResolvedValue({
    familyId: "family-1",
    groupId: "group-1",
    messageMode: "addressed_only",
    telegramChatId: "group-101",
    toolAllowlist: [],
    type: "family_private",
  });
  return repository;
}

describe("createTelegramMessageHandler reply routing", () => {
  it("continues a username-less reply to a known bot message route", async () => {
    const repository = familyGroupRepository();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    repository.session.hasRoute.mockResolvedValue(true);
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, {
      ...groupMessage("продолжи по этому ответу"),
      messageId: "89",
      replyToMessage: {
        chat: { id: "group-101", type: "group" },
        from: { firstName: "Osinara", id: "bot-1", isBot: true },
        messageId: "88",
      },
    });

    expect(repository.session.hasRoute).toHaveBeenCalledWith("group-101::88");
    expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "group-101::88",
    }));
    expect(result?.auth).toMatchObject({
      attributes: {
        groupId: "group-1",
        memoryScopes: ["family"],
        telegramReplyToMessageId: "89",
      },
    });
  });

  it("ignores a username-less reply to an unknown bot message route", async () => {
    const repository = familyGroupRepository();
    repository.session.hasRoute.mockResolvedValue(false);
    const handler = createTelegramMessageHandler(repository);

    await expect(handler(telegramContext().context, {
      ...groupMessage("ответ другому боту"),
      replyToMessage: {
        chat: { id: "group-101", type: "group" },
        from: { firstName: "Other", id: "bot-2", isBot: true },
        messageId: "188",
      },
    })).resolves.toBeNull();

    expect(repository.session.hasRoute).toHaveBeenCalledWith("group-101::188");
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });
});
