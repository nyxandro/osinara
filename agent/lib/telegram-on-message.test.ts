/**
 * Telegram authorization boundary tests.
 *
 * Constructs covered:
 * - `createTelegramMessageHandler`: dependency-injected inbound authorization handler.
 * - Secret enrollment messages terminate before Eve creates a model turn.
 * - Unknown callers can submit invitations only through `/start <token>`.
 * - Group voice captions preserve invocation after transcript insertion.
 * - Configured groups either ignore or journal passive messages by message mode.
 * - Journal deduplication prevents repeated model turns for Telegram retries.
 * - Authorized attachments persist before dispatch and enter trusted path context.
 * - Captionless photos retain a model-visible trusted workspace reference.
 * - External groups drop all inbound media before persistence, journaling, or model dispatch.
 * - Foreign replies to pending HITL prompts stop before Eve dispatch.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import {
  BOT_USERNAME,
  groupMessage,
  privateMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

describe("createTelegramMessageHandler", () => {
  it("terminates a successful bootstrap message before model dispatch", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(false);
    repository.telegram.claimFirstOwner.mockResolvedValue("claimed");
    const handler = createTelegramMessageHandler(repository);
    const { context, sendMessage } = telegramContext();

    const result = await handler(context, privateMessage("bootstrap-secret"));

    expect(result).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      "Владелец создан. Семейный агент готов к настройке.",
    );
    expect(repository.telegram.findIdentity).toHaveBeenCalledTimes(1);
    expect(repository.family.claimInvitation).not.toHaveBeenCalled();
  });

  it("creates a pending candidate and terminates the invitation message", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.family.claimInvitation.mockResolvedValue("pending");
    const handler = createTelegramMessageHandler(repository);
    const { context, sendMessage } = telegramContext();
    const token = "a".repeat(32);

    const result = await handler(context, privateMessage(`/start ${token}`));

    expect(result).toBeNull();
    expect(repository.family.claimInvitation).toHaveBeenCalledWith(token, {
      displayName: "Анна",
      telegramUserId: "telegram-101",
      username: "anna",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "AGENT_INVITATION_PENDING: Заявка отправлена владельцу. Доступ появится после подтверждения.",
    );
  });

  it("does not treat an ordinary private message as an invitation token", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    const handler = createTelegramMessageHandler(repository);
    const { context, sendMessage } = telegramContext();

    const result = await handler(context, privateMessage("пустите меня"));

    expect(result).toBeNull();
    expect(repository.family.claimInvitation).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "AGENT_ACCESS_DENIED: У вас нет доступа. Попросите владельца отправить приглашение.",
    );
  });

  it("consumes an invitation command from an existing member before model dispatch", async () => {
    const repository = repositories();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    const handler = createTelegramMessageHandler(repository);
    const { context, sendMessage } = telegramContext();

    const result = await handler(context, privateMessage(`/start ${"a".repeat(32)}`));

    expect(result).toBeNull();
    expect(repository.family.claimInvitation).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "AGENT_INVITATION_NOT_APPLICABLE: Вы уже подключены к семейному агенту.",
    );
  });

  it("persists an authorized private attachment before model dispatch", async () => {
    const repository = repositories();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "owner",
      userId: "user-1",
    });
    repository.attachments.persist.mockResolvedValue([{
      mediaType: "application/pdf",
      path: "inbox/1/договор.pdf",
      scope: "personal",
      telegramMessageId: "1",
    }]);
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...privateMessage("Сохрани договор"),
      attachments: [{
        fileId: "telegram-file-1",
        fileName: "договор.pdf",
        kind: "document" as const,
        mediaType: "application/pdf",
        size: 1_024,
      }],
    };

    const result = await handler(telegramContext().context, message);

    expect(repository.attachments.persist).toHaveBeenCalledWith({
      attachments: message.attachments,
      auth: {
        familyId: "family-1",
        groupId: null,
        groupType: null,
        role: "owner",
        telegramChatType: "private",
        userId: "user-1",
      },
      chatId: "telegram-101",
      messageId: "1",
      scope: "personal",
    });
    expect(result?.context?.join("\n")).toContain("inbox/1/договор.pdf");
    expect(result?.context?.join("\n")).toContain("safely supports Markdown tables");
  });

  it("persists a captionless private photo and exposes its trusted workspace path", async () => {
    const repository = repositories();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "owner",
      userId: "user-1",
    });
    repository.attachments.persist.mockResolvedValue([{
      mediaType: "image/jpeg",
      path: "inbox/42/photo-unique-photo.jpg",
      scope: "personal",
      telegramMessageId: "42",
    }]);
    const handler = createTelegramMessageHandler(repository);
    const message: TelegramMessage = {
      ...privateMessage(""),
      attachments: [{
        fileId: "telegram-photo-1",
        fileUniqueId: "unique-photo",
        kind: "photo",
        mediaType: "image/jpeg",
        size: 1_024,
      }],
      messageId: "42",
      raw: { photo: [{ file_id: "telegram-photo-1" }] },
    };

    const result = await handler(telegramContext().context, message);

    expect(repository.attachments.persist).toHaveBeenCalledWith(expect.objectContaining({
      attachments: message.attachments,
      messageId: "42",
      scope: "personal",
    }));
    expect(result?.context?.join("\n")).toContain("inbox/42/photo-unique-photo.jpg");
    expect(result?.context?.join("\n")).toContain("image/jpeg");
    expect(result?.context?.join("\n")).toContain('"telegramMessageId":"42"');
    expect(result?.context?.join("\n")).not.toContain("telegram-photo-1");
  });

  it.each([
    ["external_private", false],
    ["external_public", false],
    ["family_private", true],
  ] as const)(
    "%s group %s an addressed inbound document",
    async (groupType, shouldPersist) => {
      const repository = repositories();
      repository.telegram.findGroup.mockResolvedValue({
        familyId: "family-1",
        groupId: "group-1",
        messageMode: "addressed_only",
        telegramChatId: "group-101",
        toolAllowlist: [],
        type: groupType,
      });
      repository.telegram.findIdentity.mockResolvedValue({
        familyId: "family-1",
        role: "member",
        userId: "user-1",
      });
      const handler = createTelegramMessageHandler(repository);
      const message: TelegramMessage = {
        ...groupMessage(`@${BOT_USERNAME} посмотри документ`),
        attachments: [{
          fileId: "telegram-file-1",
          fileName: "документ.pdf",
          kind: "document",
          mediaType: "application/pdf",
        }],
        raw: { document: { file_id: "telegram-file-1" } },
      };

      const result = await handler(telegramContext().context, message);

      expect(repository.attachments.persist).toHaveBeenCalledTimes(shouldPersist ? 1 : 0);
      expect(repository.journal.record).not.toHaveBeenCalled();
      expect(repository.session.prepareTurn).toHaveBeenCalledTimes(shouldPersist ? 1 : 0);
      expect(result === null).toBe(!shouldPersist);
    },
  );

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
      },
    });
  });

  it("blocks another group member replying to a pending HITL prompt", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
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
      from: { firstName: "Борис", id: "telegram-202", isBot: false },
      messageId: "89",
      replyToMessage: {
        chat: { id: "group-101", type: "group" },
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
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("AGENT_APPROVAL_FORBIDDEN"));
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("does not journal an ordinary message in addressed-only mode", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external_private",
    });
    const handler = createTelegramMessageHandler(repository);

    await expect(handler(telegramContext().context, groupMessage("обычная реплика"))).resolves.toBeNull();
    expect(repository.journal.record).not.toHaveBeenCalled();
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("journals an ordinary message in all mode without starting a model turn", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external_private",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = groupMessage("контекст для будущего обращения");

    await expect(handler(telegramContext().context, message)).resolves.toBeNull();
    expect(repository.journal.record).toHaveBeenCalledWith("group-1", message);
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("adds only preceding messages from the current topic to an addressed turn", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external_private",
    });
    repository.journal.listBefore.mockResolvedValue([
      {
        contentText: "предыдущая реплика",
        messageKind: "text",
        messageThreadId: "42",
        replyToMessageId: null,
        senderDisplayName: "Анна",
        senderIsBot: false,
        senderUsername: "anna",
        sentAt: "2026-07-12T10:00:00.000Z",
        telegramMessageId: "40",
        telegramUserId: "101",
      },
    ]);
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage(`@${BOT_USERNAME} подведи итог`),
      messageId: "41",
      messageThreadId: 42,
    };

    const result = await handler(telegramContext().context, message);

    expect(repository.journal.listBefore).toHaveBeenCalledWith({
      beforeTelegramMessageId: "41",
      groupId: "group-1",
      limit: 50,
      messageThreadId: "42",
    });
    expect(result?.context?.join("\n")).toContain("предыдущая реплика");
    expect(result?.context?.join("\n")).not.toContain("подведи итог");
  });

  it("drops a duplicate all-mode delivery before authorization and model dispatch", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external_private",
    });
    repository.journal.record.mockResolvedValue("duplicate");
    const handler = createTelegramMessageHandler(repository);

    await expect(
      handler(telegramContext().context, groupMessage(`@${BOT_USERNAME} ответь`)),
    ).resolves.toBeNull();
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
    expect(repository.journal.listBefore).not.toHaveBeenCalled();
  });

  it("continues an addressed turn without journal context when mode changed concurrently", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external_private",
    });
    repository.journal.record.mockResolvedValue("mode_disabled");
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(
      telegramContext().context,
      groupMessage(`@${BOT_USERNAME} ответь`),
    );

    expect(result?.auth).not.toBeNull();
    expect(repository.journal.listBefore).not.toHaveBeenCalled();
  });

  it("journals an unauthorized family-group message but does not start a turn", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "family_private",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = groupMessage(`@${BOT_USERNAME} открой семейную память`);

    await expect(handler(telegramContext().context, message)).resolves.toBeNull();
    expect(repository.journal.record).toHaveBeenCalledWith("group-1", message);
    expect(repository.journal.listBefore).not.toHaveBeenCalled();
  });

  it("does not journal messages from an unknown group", async () => {
    const repository = repositories();
    const handler = createTelegramMessageHandler(repository);

    await expect(handler(telegramContext().context, groupMessage("обычная реплика"))).resolves.toBeNull();
    expect(repository.journal.record).not.toHaveBeenCalled();
  });
});
