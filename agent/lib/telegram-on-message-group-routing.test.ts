/**
 * Telegram group routing authorization boundary tests.
 *
 * Constructs covered:
 * - `createTelegramMessageHandler`: invitation, voice, HITL, and passive group routing.
 * - Unified timeline preparation retains exact forum and reply routing.
 * - Duplicate and unauthorized group updates stop before model dispatch.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

describe("createTelegramMessageHandler group routing", () => {
  it("resumes a verified interrupted preparation even when its history row already exists", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({ familyId: "family-1", groupId: "group-1", messageMode: "addressed_only",
      skillAllowlist: [], telegramChatId: "group-101", toolAllowlist: [], type: "family_private" });
    repository.telegram.findIdentity.mockResolvedValue({ familyId: "family-1", role: "member", userId: "user-1" });
    repository.journal.record.mockResolvedValue({ entryId: "00000000-0000-4000-8000-000000000010", replyToAgent: false,
      replyTargetUnavailable: false, replyToSequenceId: null, sequenceId: "1", status: "duplicate" });
    const { context } = telegramContext();
    const result = await createTelegramMessageHandler(repository)({ ...context,
      ingressRecovery: { updateId: "42", dispatchId: "123e4567-e89b-42d3-a456-426614174000" } }, groupMessage(`@${BOT_USERNAME} ответь`));
    expect(result?.auth?.attributes.telegramTimelineEntryId).toBe("00000000-0000-4000-8000-000000000010");
    expect(repository.session.prepareTurn).toHaveBeenCalledOnce();
  });
  it("silently consumes an invitation command posted in a group", async () => {
    const repository = repositories();
    const handler = createTelegramMessageHandler(repository);
    const { context, sendMessage } = telegramContext();

    const result = await handler(context, groupMessage(`/start ${"a".repeat(32)}`));

    expect(result).toBeNull();
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
    expect(repository.telegram.findGroup).not.toHaveBeenCalled();
    expect(repository.family.claimInvitation).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves a family-group mention carried by a transcribed voice caption", async () => {
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
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    const handler = createTelegramMessageHandler(repository);
    const { context } = telegramContext();
    const message = {
      ...groupMessage("Распознанный голосовой текст"),
      caption: `@${BOT_USERNAME} ответь на запись`,
    };

    const result = await handler(context, message);

    expect(result?.auth).toMatchObject({
      attributes: {
        groupId: "group-1",
        groupType: "family_private",
        memoryScopes: ["family"],
        sandboxSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        telegramReplyToMessageId: "1",
      },
    });
  });

  it("blocks another group member replying to a pending HITL prompt", async () => {
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
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-2",
    });
    repository.hitl.authorizeReply.mockResolvedValue("forbidden");
    const handler = createTelegramMessageHandler(repository);
    const { context, sendMessage } = telegramContext();
    const message: TelegramMessage = {
      ...groupMessage("Подтвердить"),
      chat: { id: "group-101", title: "Форум", type: "supergroup" },
      from: { firstName: "Борис", id: "telegram-202", isBot: false },
      messageId: "89",
      messageThreadId: 88,
      replyToMessage: {
        chat: { id: "group-101", type: "supergroup" },
        from: {
          firstName: "Osinara",
          id: "bot-1",
          isBot: true,
          username: BOT_USERNAME,
        },
        messageId: "88",
      },
    };

    await expect(handler(context, message)).resolves.toBeNull();
    expect(repository.hitl.authorizeReply).toHaveBeenCalledWith({
      baseContinuationToken: "group-101::88",
      telegramChatId: "group-101",
      telegramMessageId: "88",
      telegramUserId: "telegram-202",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();

    // Existing topics retain the referenced bot message's thread instead of the incoming value.
    repository.hitl.authorizeReply.mockClear();
    await handler(context, {
      ...message,
      replyToMessage: { ...message.replyToMessage!, messageThreadId: 42 },
    });
    expect(repository.hitl.authorizeReply).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "group-101:42:88",
    }));
  });

  it("records an ordinary message in the unified timeline without starting a turn", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external",
    });
    const handler = createTelegramMessageHandler(repository);

    await expect(handler(telegramContext().context, groupMessage("обычная реплика"))).resolves.toBeNull();
    expect(repository.journal.record).toHaveBeenCalledTimes(1);
    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledWith({
      groupId: "group-1",
      timelineEntryId: "00000000-0000-4000-8000-000000000010",
    });
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("journals an ordinary message in all mode without starting a model turn", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = groupMessage("контекст для будущего обращения");

    await expect(handler(telegramContext().context, message)).resolves.toBeNull();
    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-1",
      message,
      expect.objectContaining({ id: "telegram-101", kind: "telegram_user" }),
    );
    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledTimes(1);
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("adds only preceding messages from the current topic to an addressed turn", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external",
    });
    repository.groupContext.prepare.mockResolvedValue({
      cursorSequence: "1",
      durableMessage: "предыдущая реплика\n\nподведи итог",
      currentMessageEnvelope: "подведи итог",
      omittedBeforeSequence: null,
      timelineOmission: null,
      visibleEntryIds: ["00000000-0000-4000-8000-000000000010"],
      visibleTimelineEntries: [],
    });
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage(`@${BOT_USERNAME} подведи итог`),
      messageId: "41",
      messageThreadId: 42,
      raw: { date: 1_700_000_000, is_topic_message: true },
    };

    const result = await handler(telegramContext().context, message);

    expect(repository.groupContext.prepare).toHaveBeenCalledWith({
      applicationSessionId: "session-1",
      currentEntryId: "00000000-0000-4000-8000-000000000010",
      currentSenderDisplayName: "Анна",
      currentSenderUsername: "anna",
      currentSequence: "1",
      groupId: "group-1",
      attachmentReferenceAccess: { images: false, readableText: false },
      messageText: `@${BOT_USERNAME} подведи итог`,
      messageThreadId: "42",
      replyTargetUnavailable: false,
      replyToSequenceId: null,
      triggeredBy: "mention",
    });
    expect(result?.message).toContain("предыдущая реплика");
    expect(result?.context?.join("\n")).not.toContain("предыдущая реплика");
  });

  it("passes the exact current reply relationship into the durable group envelope", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000013",
      replyToAgent: false,
      replyTargetUnavailable: false,
      replyToSequenceId: "8",
      sequenceId: "13",
      status: "inserted",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage(`@${BOT_USERNAME} ты видишь, на что я ответил?`),
      messageId: "13",
      replyToMessage: {
        chat: { id: "group-101", title: "Группа", type: "group" as const },
        from: { firstName: "Сергей", id: "telegram-202", isBot: false },
        messageId: "8",
      },
    };

    await handler(telegramContext().context, message);

    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({
      currentEntryId: "00000000-0000-4000-8000-000000000013",
      currentSequence: "13",
      replyTargetUnavailable: false,
      replyToSequenceId: "8",
    }));
  });

  it("passes the highlighted fragment of a journaled reply target", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000014",
      replyToAgent: true,
      replyTargetUnavailable: false,
      replyToSequenceId: "8",
      sequenceId: "14",
      status: "inserted",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage("опа, а шо это значит"),
      messageId: "14",
      raw: {
        date: 1_786_542_434,
        quote: { is_manual: true, position: 44, text: "чат на сорок человек" },
        reply_to_message: {
          chat: { id: "group-101", title: "Группа", type: "group" },
          from: { first_name: "Осинара", id: 777, is_bot: true, username: BOT_USERNAME },
          message_id: 8,
          text: "Я не рассылала чужие пикантные фото в чат на сорок человек",
        },
      },
      replyToMessage: {
        chat: { id: "group-101", title: "Группа", type: "group" as const },
        from: { firstName: "Осинара", id: "777", isBot: true, username: BOT_USERNAME },
        messageId: "8",
      },
    };

    await handler(telegramContext().context, message);

    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({
      replyQuotedText: "чат на сорок человек",
      replyTargetUnavailable: false,
      replyToSequenceId: "8",
      triggeredBy: "reply_to_agent",
    }));
  });

  it("keeps a reply target from another chat out of the prepared turn", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000015",
      replyToAgent: false,
      replyTargetUnavailable: true,
      replyToSequenceId: null,
      sequenceId: "15",
      status: "inserted",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage(`@${BOT_USERNAME} а чо это`),
      messageId: "15",
      raw: {
        date: 1_786_542_434,
        quote: { text: "фрагмент чужой переписки" },
        reply_to_message: {
          chat: { id: "group-909", title: "Другая группа", type: "group" },
          from: { first_name: "Сергей", id: 202, is_bot: false },
          message_id: 77,
          text: "Текст из другой переписки",
        },
      },
      replyToMessage: {
        chat: { id: "group-909", title: "Другая группа", type: "group" as const },
        from: { firstName: "Сергей", id: "telegram-202", isBot: false },
        messageId: "77",
      },
    };

    await handler(telegramContext().context, message);

    const [prepared] = repository.groupContext.prepare.mock.calls[0] as [Record<string, unknown>];
    expect(prepared).not.toHaveProperty("replyQuotedText");
    expect(prepared).not.toHaveProperty("replyTargetSnapshot");
    expect(prepared).toMatchObject({ replyTargetUnavailable: true, replyToSequenceId: null });
  });

  it("passes a verified raw reply snapshot when the target was not journaled", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000013",
      replyToAgent: false,
      replyTargetUnavailable: true,
      replyToSequenceId: null,
      sequenceId: "13",
      status: "inserted",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage(`@${BOT_USERNAME} а чо это`),
      messageId: "51002",
      raw: {
        date: 1_786_542_434,
        quote: { text: "streisand" },
        reply_to_message: {
          chat: { id: "group-101", title: "Группа", type: "group" },
          message_id: 51_001,
          sender_chat: { id: -1001, title: "nlp_daily", type: "channel", username: "nlp_daily" },
          text: "У меня настроен vless, ссылочку кинул в streisand",
        },
      },
      replyToMessage: {
        chat: { id: "group-101", title: "Группа", type: "group" as const },
        from: { firstName: "Channel", id: "telegram-channel", isBot: true },
        messageId: "51001",
      },
    };

    await handler(telegramContext().context, message);

    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({
      replyQuotedText: "streisand",
      replyTargetSnapshot: {
        contentText: "У меня настроен vless, ссылочку кинул в streisand",
        senderDisplayName: "nlp_daily",
        senderUsername: "nlp_daily",
      },
      replyTargetUnavailable: true,
      replyToSequenceId: null,
    }));
  });

  it("drops a duplicate all-mode delivery before authorization and model dispatch", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external",
    });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000010",
      replyToAgent: false,
      sequenceId: "1",
      status: "duplicate",
    });
    const handler = createTelegramMessageHandler(repository);

    await expect(
      handler(telegramContext().context, groupMessage(`@${BOT_USERNAME} ответь`)),
    ).resolves.toBeNull();
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
    expect(repository.groupContext.prepare).not.toHaveBeenCalled();
  });

  it("records an unauthorized family-group participant without granting agent access", async () => {
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
    const handler = createTelegramMessageHandler(repository);
    const message = groupMessage(`@${BOT_USERNAME} открой семейную память`);

    await expect(handler(telegramContext().context, message)).resolves.toBeNull();
    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-1",
      message,
      expect.objectContaining({ id: "telegram-101", kind: "telegram_user" }),
    );
    expect(repository.groupContext.prepare).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("does not journal messages from an unknown group", async () => {
    const repository = repositories();
    const handler = createTelegramMessageHandler(repository);

    await expect(handler(telegramContext().context, groupMessage("обычная реплика"))).resolves.toBeNull();
    expect(repository.journal.record).not.toHaveBeenCalled();
  });
});
