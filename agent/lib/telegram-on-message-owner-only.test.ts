/**
 * Telegram external-group owner-only dispatch tests.
 *
 * Constructs covered:
 * - Passive messages from every participant remain in the isolated group timeline, media with its
 *   attachment reference and memory review.
 * - Only the current Osinara family owner may start a model turn in owner-only mode.
 * - Telegram administrators and ordinary family members receive no implicit dispatch authority.
 */
import { describe, expect, it } from "vitest";

import { createTelegramMessageHandler } from "./telegram-on-message.js";
import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";

function ownerOnlyGroup() {
  return {
    familyId: "family-1",
    groupId: "group-1",
    messageMode: "owner_only" as const,
    skillAllowlist: [],
    telegramChatId: "group-101",
    toolAllowlist: ["list_group_history"],
    type: "external" as const,
  };
}

describe("Telegram owner-only external group dispatch", () => {
  it("journals passive messages without resolving participant identity", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(ownerOnlyGroup());
    const handler = createTelegramMessageHandler(repository);
    const message = groupMessage("обычная реплика для будущего саммари");

    await expect(handler(telegramContext().context, message)).resolves.toBeNull();

    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-1",
      message,
      expect.objectContaining({ id: "telegram-101", kind: "telegram_user" }),
    );
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("keeps a participant's passive sticker with its preview and memory review, without a turn", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(ownerOnlyGroup());
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage(""),
      attachments: [{ fileId: "preview-1", fileName: "preview.jpg", kind: "photo" as const, mediaType: "image/jpeg" }],
      raw: { date: 1_700_000_000, sticker: { emoji: "😂", file_id: "sticker-1", file_unique_id: "s1", height: 1, is_animated: true, is_video: false, type: "regular", width: 1 } },
    };

    await expect(handler(telegramContext().context, message)).resolves.toBeNull();

    expect(repository.attachmentReferences.record).toHaveBeenCalledWith("group-1", message);
    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledTimes(1);
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("silently rejects an addressed request from an external participant", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(ownerOnlyGroup());
    const handler = createTelegramMessageHandler(repository);
    const message = groupMessage(`@${BOT_USERNAME} ответь мне`);

    await expect(handler(telegramContext().context, message)).resolves.toBeNull();

    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-1",
      message,
      expect.objectContaining({ id: "telegram-101", kind: "telegram_user" }),
    );
    expect(repository.telegram.findIdentity).toHaveBeenCalledWith("telegram-101");
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("silently rejects an addressed request from an ordinary family member", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(ownerOnlyGroup());
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "member-1",
    });
    const handler = createTelegramMessageHandler(repository);

    await expect(
      handler(telegramContext().context, groupMessage(`@${BOT_USERNAME} ответь мне`)),
    ).resolves.toBeNull();

    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("dispatches an addressed request from the current family owner", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(ownerOnlyGroup());
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "owner",
      userId: "owner-1",
    });
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(
      telegramContext().context,
      groupMessage(`@${BOT_USERNAME} сделай саммари за сутки`),
    );

    expect(repository.session.prepareTurn).toHaveBeenCalledOnce();
    expect(result?.auth).toMatchObject({
      attributes: { role: "owner", groupId: "group-1" },
      principalId: "owner-1",
    });
  });

  it("fails closed when group policy changes while an addressed turn is being authorized", async () => {
    const repository = repositories();
    repository.telegram.findGroup
      .mockResolvedValueOnce({ ...ownerOnlyGroup(), messageMode: "all" })
      .mockResolvedValueOnce(ownerOnlyGroup());
    repository.telegram.findIdentity.mockResolvedValue(null);

    await expect(createTelegramMessageHandler(repository)(
      telegramContext().context,
      groupMessage(`@${BOT_USERNAME} ответь мне`),
    )).resolves.toBeNull();

    expect(repository.telegram.findGroup).toHaveBeenCalledTimes(2);
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });
});
