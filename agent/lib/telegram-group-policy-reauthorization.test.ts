/**
 * Telegram live group-policy reauthorization tests.
 *
 * Constructs covered:
 * - A skill grant changed between registration reads stops dispatch before turn creation.
 */
import { describe, expect, it } from "vitest";

import { createTelegramMessageHandler } from "./telegram-on-message.js";
import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";

describe("Telegram group policy reauthorization", () => {
  it("rejects a turn when the skill allowlist changes during live reauthorization", async () => {
    const repository = repositories();
    const group = {
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only" as const,
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external" as const,
    };
    repository.telegram.findGroup
      .mockResolvedValueOnce({ ...group, skillAllowlist: ["behavior-preferences"] })
      .mockResolvedValueOnce({ ...group, skillAllowlist: [] });
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "owner",
      userId: "user-1",
    });

    await expect(createTelegramMessageHandler(repository)(
      telegramContext().context,
      groupMessage(`@${BOT_USERNAME} ответь мне`),
    )).resolves.toBeNull();

    expect(repository.telegram.findGroup).toHaveBeenCalledTimes(2);
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });
});
