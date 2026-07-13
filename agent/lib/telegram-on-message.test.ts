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
 */
import type { TelegramContext, TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { createTelegramMessageHandler } from "./telegram-on-message.js";

const BOT_USERNAME = "osinara_bot";

function privateMessage(text: string): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "telegram-101", type: "private" },
    from: { firstName: "Анна", id: "telegram-101", isBot: false, username: "anna" },
    messageId: "1",
    raw: { date: 1_700_000_000 },
    text,
  };
}

function groupMessage(text: string): TelegramMessage {
  return {
    ...privateMessage(text),
    chat: { id: "group-101", title: "Группа", type: "group" },
  };
}

function telegramContext() {
  const sendMessage = vi.fn().mockResolvedValue({});
  return {
    context: {
      telegram: {
        botUsername: BOT_USERNAME,
        sendMessage,
      },
    } as unknown as TelegramContext,
    sendMessage,
  };
}

function repositories() {
  return {
    attachments: {
      persist: vi.fn().mockResolvedValue([]),
    },
    family: {
      claimInvitation: vi.fn(),
    },
    journal: {
      listBefore: vi.fn().mockResolvedValue([]),
      record: vi.fn().mockResolvedValue("inserted"),
    },
    session: {
      prepareTurn: vi.fn().mockResolvedValue({
        continuationToken: "telegram-101::",
        generation: 0,
        id: "session-1",
        rotated: false,
      }),
    },
    telegram: {
      claimFirstOwner: vi.fn(),
      findGroup: vi.fn().mockResolvedValue(null),
      findIdentity: vi.fn().mockResolvedValue(null),
      hasOwner: vi.fn(),
    },
  };
}

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
    expect(result?.context?.join("\n")).toContain("GitHub-flavored Markdown");
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

  it("preserves a group mention carried by a transcribed voice caption", async () => {
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
    const { context } = telegramContext();
    const message = {
      ...groupMessage("Распознанный голосовой текст"),
      caption: `@${BOT_USERNAME} ответь на запись`,
    };

    const result = await handler(context, message);

    expect(result?.auth).toMatchObject({
      attributes: {
        groupId: "group-1",
        groupType: "external_private",
        memoryScopes: ["group"],
        toolAllowlist: ["remember"],
      },
    });
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
