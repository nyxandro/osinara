/**
 * Telegram group reply routing regression tests.
 *
 * Constructs covered:
 * - Username-less replies to prior Osinara bot messages continue via persisted session routes.
 * - Exact replies to Osinara tool-delivered messages bypass synthetic HITL without a timeline row.
 * - Timeline-proven replies without an Eve route start a fresh application continuation.
 * - Ordinary replies remain messages when a previously live route rotates before Eve dispatch.
 * - Only authorized HITL replies retain Eve's native synthetic reply handling.
 * - Private non-HITL replies also bypass synthetic input-response delivery.
 * - Sender-less Telegram reply references continue only when their exact persisted route exists.
 * - Replies to user messages never wake the agent merely because their route is still live.
 * - Replies to unknown bot messages stay ignored, so other bots cannot trigger Osinara turns.
 */
import { describe, expect, it } from "vitest";

import {
  BOT_USERNAME,
  groupMessage,
  privateMessage,
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
    skillAllowlist: [],
    telegramChatId: "group-101",
    toolAllowlist: [],
    type: "family_private",
  });
  return repository;
}

describe("createTelegramMessageHandler reply routing", () => {
  it("starts a normal continuation for an exact Osinara reply missing from the timeline", async () => {
    const repository = familyGroupRepository();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    repository.session.hasRoute.mockResolvedValue(false);
    repository.hitl.authorizeReply.mockResolvedValue("not_applicable");
    repository.session.prepareTurn.mockResolvedValue({
      continuationToken: "group-101::340:osinara:2",
      generation: 2,
      id: "session-tool-delivery",
      rotated: false,
      sandboxSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, {
      ...groupMessage("который час?"),
      messageId: "342",
      replyToMessage: {
        chat: { id: "group-101", type: "group" },
        from: {
          firstName: "Osinara",
          id: "bot-1",
          isBot: true,
          username: BOT_USERNAME,
        },
        messageId: "340",
      },
    });

    expect(repository.hitl.authorizeReply).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "group-101::340",
      telegramMessageId: "340",
    }));
    expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "osinara:group:group-1:main",
      kind: "canonical",
      telegramForumTopicId: null,
    }));
    expect(result).toMatchObject({
      continuationToken: "group-101::340:osinara:2",
      replyHandling: "message",
    });
  });

  it("starts a fresh message continuation for a timeline-proven agent reply without a route", async () => {
    const repository = familyGroupRepository();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000340",
      replyToAgent: true,
      sequenceId: "342",
      status: "inserted",
    });
    repository.session.hasRoute.mockResolvedValue(false);
    repository.hitl.authorizeReply.mockResolvedValue("not_applicable");
    repository.session.prepareTurn.mockResolvedValue({
      continuationToken: "group-101::340:osinara:2",
      generation: 2,
      id: "session-rotated",
      rotated: true,
      sandboxSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, {
      ...groupMessage("продолжи эту ветку"),
      messageId: "342",
      replyToMessage: {
        chat: { id: "group-101", type: "group" },
        from: { firstName: "Osinara", id: "bot-1", isBot: true },
        messageId: "340",
      },
    });

    expect(repository.session.hasRoute).toHaveBeenCalledWith("group-101::340");
    expect(repository.groupContext.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredBy: "reply_to_agent" }),
    );
    expect(result?.auth?.attributes).toMatchObject({ telegramGroupTurnTrigger: "reply_to_agent" });
    expect(repository.hitl.authorizeReply).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "group-101::340",
      telegramMessageId: "340",
    }));
    expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "osinara:group:group-1:main",
      kind: "canonical",
    }));
    expect(result).toMatchObject({
      continuationToken: "group-101::340:osinara:2",
      replyHandling: "message",
    });
    expect(result?.auth?.attributes).toMatchObject({
      telegramReplyToMessageId: "342",
      telegramTimelineEntryId: "00000000-0000-4000-8000-000000000340",
    });
  });

  it("keeps a known-route reply as a message when session preparation rotates the route", async () => {
    const repository = familyGroupRepository();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000088",
      replyToAgent: true,
      sequenceId: "89",
      status: "inserted",
    });
    repository.session.hasRoute.mockResolvedValue(true);
    repository.hitl.authorizeReply.mockResolvedValue("not_applicable");
    repository.session.prepareTurn.mockResolvedValue({
      continuationToken: "group-101::88:osinara:1",
      generation: 1,
      id: "session-rotated",
      rotated: true,
      sandboxSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
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
      baseContinuationToken: "osinara:group:group-1:main",
      kind: "canonical",
    }));
    expect(result?.auth).toMatchObject({
      attributes: {
        groupId: "group-1",
        memoryScopes: ["family"],
        telegramReplyToMessageId: "89",
      },
    });
    expect(result).toMatchObject({
      continuationToken: "group-101::88:osinara:1",
      replyHandling: "message",
    });
  });

  it("dispatches a private non-HITL bot reply as an ordinary message", async () => {
    const repository = repositories();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "owner",
      userId: "user-1",
    });
    repository.hitl.authorizeReply.mockResolvedValue("not_applicable");
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, {
      ...privateMessage("продолжим"),
      messageId: "89",
      replyToMessage: {
        chat: { id: "telegram-101", type: "private" },
        from: { firstName: "Osinara", id: "bot-1", isBot: true },
        messageId: "88",
      },
    });

    expect(repository.hitl.authorizeReply).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "telegram-101::88",
      telegramMessageId: "88",
    }));
    expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "telegram-101::88",
    }));
    expect(result).toMatchObject({ replyHandling: "message" });
  });

  it("preserves native reply handling for an authorized HITL response", async () => {
    const repository = familyGroupRepository();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000341",
      replyToAgent: true,
      sequenceId: "343",
      status: "inserted",
    });
    repository.session.hasRoute.mockResolvedValue(false);
    repository.hitl.authorizeReply.mockResolvedValue("authorized");
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, {
      ...groupMessage("да"),
      messageId: "343",
      replyToMessage: {
        chat: { id: "group-101", type: "group" },
        from: { firstName: "Osinara", id: "bot-1", isBot: true },
        messageId: "341",
      },
    });

    expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "group-101::341",
      kind: "task",
    }));
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("replyHandling");
    expect(repository.memoryReview.prepareInteractiveTurn).not.toHaveBeenCalled();
  });

  it("continues a sender-less reply to an exact known Osinara route", async () => {
    const repository = familyGroupRepository();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    repository.session.hasRoute.mockResolvedValue(true);
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, {
      ...groupMessage("куку"),
      messageId: "89",
      replyToMessage: {
        chat: { id: "group-101", type: "group" },
        messageId: "88",
      },
    });

    expect(repository.session.hasRoute).toHaveBeenCalledWith("group-101::88");
    expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "osinara:group:group-1:main",
      kind: "canonical",
    }));
    expect(result).not.toBeNull();
  });

  it("ignores a reply to a user message even when its exact session route is live", async () => {
    const repository = familyGroupRepository();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    repository.session.hasRoute.mockResolvedValue(true);
    const handler = createTelegramMessageHandler(repository);

    // Telegram's explicit non-bot sender is authoritative; route liveness cannot turn a user
    // message into an Osinara anchor in an addressed-only group.
    const result = await handler(telegramContext().context, {
      ...groupMessage("ответ участнику"),
      messageId: "89",
      replyToMessage: {
        chat: { id: "group-101", type: "group" },
        from: { firstName: "Борис", id: "telegram-202", isBot: false },
        messageId: "88",
      },
    });

    expect(result).toBeNull();
    expect(repository.session.hasRoute).not.toHaveBeenCalled();
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("continues a forum reply through a persisted pre-fix threadless route", async () => {
    const repository = familyGroupRepository();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    repository.session.hasRoute
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, {
      ...groupMessage("как дела?"),
      messageId: "280",
      messageThreadId: 278,
      replyToMessage: {
        chat: { id: "group-101", type: "supergroup" },
        from: {
          firstName: "Osinara",
          id: "bot-1",
          isBot: true,
          username: "osinara_bot",
        },
        messageId: "279",
        messageThreadId: 278,
      },
    });

    expect(repository.session.hasRoute).toHaveBeenNthCalledWith(1, "group-101:278:279");
    expect(repository.session.hasRoute).toHaveBeenNthCalledWith(2, "group-101::279");
    expect(repository.session.prepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "osinara:group:group-1:main",
      kind: "canonical",
    }));
    expect(result).not.toBeNull();
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
