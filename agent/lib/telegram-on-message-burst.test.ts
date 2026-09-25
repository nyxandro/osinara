/**
 * Telegram preparation of a private message that is part of a burst.
 *
 * Constructs covered:
 * - A private text followed by another waiting message of its chat is written to the conversation
 *   and starts no turn; the last message of the burst starts the one turn that answers all of them.
 * - A message with files, a command, and an answer to a pending confirmation always start a turn.
 * - A group message and a message prepared outside the durable ingress never consult the queue.
 */
import { describe, expect, it } from "vitest";

import { groupMessage, privateMessage, repositories, telegramContext } from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

const INGRESS = { dispatchId: "123e4567-e89b-42d3-a456-426614174000", updateId: "501" };

function ownerRepositories(following: boolean) {
  const repository = repositories();
  repository.telegram.findIdentity.mockResolvedValue({ familyId: "family-1", role: "owner", userId: "user-1" });
  repository.privateBursts.hasFollowingMessage.mockResolvedValue(following);
  return repository;
}

describe("private burst preparation", () => {
  it("writes a message followed by another one to the conversation without a turn", async () => {
    const repository = ownerRepositories(true);
    const handler = createTelegramMessageHandler(repository);

    const result = await handler({ ...telegramContext().context, ingressRecovery: INGRESS }, privateMessage("вот такой ответ ты прислала"));

    expect(result).toBeNull();
    expect(repository.privateBursts.hasFollowingMessage).toHaveBeenCalledWith("501");
    expect(repository.timeline.recordInbound).toHaveBeenCalledTimes(1);
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("starts the turn for the last message of the burst", async () => {
    const repository = ownerRepositories(false);
    const handler = createTelegramMessageHandler(repository);

    const result = await handler({ ...telegramContext().context, ingressRecovery: INGRESS }, privateMessage("нужны только внятные обновления"));

    expect(result).not.toBeNull();
    expect(repository.session.prepareTurn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a message with files", () => ({
      ...privateMessage("посмотри"),
      attachments: [{ fileId: "telegram-file-1", fileName: "счёт.pdf", kind: "document" as const, mediaType: "application/pdf", size: 1_024 }],
    })],
    ["a command", () => privateMessage("/help")],
  ])("starts a turn for %s even inside a burst", async (_label, message) => {
    const repository = ownerRepositories(true);
    const handler = createTelegramMessageHandler(repository);

    await handler({ ...telegramContext().context, ingressRecovery: INGRESS }, message() as never);

    expect(repository.privateBursts.hasFollowingMessage).not.toHaveBeenCalled();
  });

  it("starts a turn for an answer to a pending confirmation", async () => {
    const repository = ownerRepositories(true);
    repository.hitl.authorizeReply.mockResolvedValue("authorized");
    const handler = createTelegramMessageHandler(repository);
    const answer = {
      ...privateMessage("да"),
      replyToMessage: { ...privateMessage("Подтвердить отправку?"), from: { firstName: "Osinara", id: "900", isBot: true }, messageId: "7" },
    };

    const result = await handler({ ...telegramContext().context, ingressRecovery: INGRESS }, answer as never);

    expect(result).not.toBeNull();
    expect(repository.privateBursts.hasFollowingMessage).not.toHaveBeenCalled();
  });

  it("never consults the queue outside a private chat or outside the durable ingress", async () => {
    const outside = ownerRepositories(true);
    await createTelegramMessageHandler(outside)(telegramContext().context, privateMessage("привет"));
    expect(outside.privateBursts.hasFollowingMessage).not.toHaveBeenCalled();

    const group = ownerRepositories(true);
    group.telegram.findGroup.mockResolvedValue({
      familyId: "family-1", groupId: "group-1", messageMode: "all", skillAllowlist: [], telegramChatId: "group-101",
      toolAllowlist: [], type: "family_private",
    });
    await createTelegramMessageHandler(group)({ ...telegramContext().context, ingressRecovery: INGRESS }, groupMessage("@osinara_bot привет"));
    expect(group.privateBursts.hasFollowingMessage).not.toHaveBeenCalled();
  });
});
