/**
 * Telegram channel-authored supergroup routing tests.
 *
 * Constructs covered:
 * - Addressed channel posts start external group turns under a service principal.
 * - Passive channel posts remain visible in timeline without entering human memory review.
 * - Family-private and owner-only policies reject channel actors before persistence.
 * - Channel replies to Osinara remain ordinary messages and never enter HITL authorization.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { describe, expect, it } from "vitest";

import { createTelegramMessageHandler } from "./telegram-on-message.js";
import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";

const CHANNEL_ACTOR = {
  actorId: "telegram-channel:-1001783384254",
  displayName: "Pavel Zloi",
  id: "-1001783384254",
  kind: "telegram_channel" as const,
  timelineKind: "telegram_channel" as const,
  username: "evilfreelancer",
};

function channelMessage(text: string): TelegramMessage {
  return {
    ...groupMessage(text),
    chat: { id: "group-101", title: "Остриков пилит агентов", type: "supergroup" },
    from: { firstName: "Channel", id: "136817688", isBot: true, username: "Channel_Bot" },
    messageId: "54068",
    raw: {
      date: 1_787_000_000,
      from: { first_name: "Channel", id: 136_817_688, is_bot: true, username: "Channel_Bot" },
      sender_chat: {
        id: -1_001_783_384_254,
        title: "Pavel Zloi",
        type: "channel",
        username: "evilfreelancer",
      },
    },
  };
}

function externalGroup(messageMode: "addressed_only" | "all" | "owner_only" = "addressed_only") {
  return {
    familyId: "family-1",
    groupId: "group-1",
    messageMode,
    skillAllowlist: ["pohuy"],
    telegramChatId: "group-101",
    toolAllowlist: ["list_group_history", "remember"],
    type: "external" as const,
  };
}

describe("Telegram channel sender routing", () => {
  it("starts an addressed external turn with channel attribution and no human authority", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(externalGroup());
    const message = channelMessage(`@${BOT_USERNAME} ты меня видишь?`);

    const result = await createTelegramMessageHandler(repository)(telegramContext().context, message);

    expect(repository.journal.record).toHaveBeenCalledWith("group-1", message, CHANNEL_ACTOR);
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
    expect(repository.family.claimInvitation).not.toHaveBeenCalled();
    expect(repository.hitl.authorizeReply).not.toHaveBeenCalled();
    expect(repository.memoryReview.prepareInteractiveTurn).not.toHaveBeenCalled();
    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({
      currentSenderDisplayName: "Pavel Zloi",
      currentSenderUsername: "evilfreelancer",
    }));
    expect(result?.auth).toMatchObject({
      attributes: {
        groupId: "group-1",
        groupType: "external",
        memoryScopes: ["group"],
        role: "external",
        telegramActorId: "-1001783384254",
        telegramActorKind: "telegram_channel",
      },
      authenticator: "telegram",
      principalId: "telegram-channel:-1001783384254",
      principalType: "service",
    });
    expect(result?.auth?.attributes).not.toHaveProperty("telegramUserId");
  });

  it("journals a passive channel post without treating it as a human review source", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(externalGroup());
    const message = channelMessage("обычная реплика канала");

    await expect(
      createTelegramMessageHandler(repository)(telegramContext().context, message),
    ).resolves.toBeNull();

    expect(repository.journal.record).toHaveBeenCalledWith("group-1", message, CHANNEL_ACTOR);
    expect(repository.memoryReview.observePassiveMessage).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "addressed_only" as const, type: "family_private" as const },
    { mode: "owner_only" as const, type: "external" as const },
  ])("rejects a channel actor in $type/$mode", async ({ mode, type }) => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      ...externalGroup(mode),
      type,
    });

    await expect(createTelegramMessageHandler(repository)(
      telegramContext().context,
      channelMessage(`@${BOT_USERNAME} ответь`),
    )).resolves.toBeNull();

    expect(repository.journal.record).not.toHaveBeenCalled();
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("treats a channel reply to Osinara as a message, never as HITL approval", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(externalGroup());
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000010",
      replyToAgent: true,
      replyTargetUnavailable: false,
      replyToSequenceId: "99",
      sequenceId: "100",
      status: "inserted",
    });
    const message = {
      ...channelMessage("ответ канала"),
      replyToMessage: {
        chat: { id: "group-101", type: "supergroup" as const },
        from: { firstName: "Осинара", id: "bot-1", isBot: true, username: BOT_USERNAME },
        messageId: "99",
      },
    };

    const result = await createTelegramMessageHandler(repository)(telegramContext().context, message);

    expect(repository.hitl.authorizeReply).not.toHaveBeenCalled();
    expect(result?.replyHandling).toBe("message");
    expect(result?.auth?.principalType).toBe("service");
  });
});
