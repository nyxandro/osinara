/**
 * Telegram voice authorization tests.
 *
 * Constructs covered:
 * - `createTelegramVoiceAuthorizer`: limits Groq transcription to personal and family spaces.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramVoiceAuthorizer } from "./telegram-voice-authorization.js";

describe("createTelegramVoiceAuthorizer", () => {
  it("allows a registered family member in a private chat", async () => {
    const telegram = {
      findGroup: vi.fn(),
      findIdentity: vi.fn().mockResolvedValue({
        familyId: "family-1",
        role: "member",
        userId: "user-1",
      }),
    };
    const authorize = createTelegramVoiceAuthorizer(telegram);

    await expect(
      authorize({ chat: { id: "101", type: "private" }, from: { id: "101", isBot: false } }),
    ).resolves.toBe(true);
    expect(telegram.findGroup).not.toHaveBeenCalled();
  });

  it("denies an unknown private caller before transcription", async () => {
    const authorize = createTelegramVoiceAuthorizer({
      findGroup: vi.fn(),
      findIdentity: vi.fn().mockResolvedValue(null),
    });

    await expect(
      authorize({ chat: { id: "101", type: "private" }, from: { id: "101", isBot: false } }),
    ).resolves.toBe(false);
  });

  it("denies a caller from another family in a private family group", async () => {
    const authorize = createTelegramVoiceAuthorizer({
      findGroup: vi.fn().mockResolvedValue({
        familyId: "family-1",
        groupId: "group-1",
        telegramChatId: "-1001",
        toolAllowlist: [],
        type: "family_private",
      }),
      findIdentity: vi.fn().mockResolvedValue({
        familyId: "family-2",
        role: "member",
        userId: "user-2",
      }),
    });

    await expect(
      authorize({
        chat: { id: "-1001", type: "supergroup" },
        from: { id: "202", isBot: false },
      }),
    ).resolves.toBe(false);
  });

  it.each(["external_private", "external_public"] as const)(
    "denies %s voice before identity lookup and Groq transcription",
    async (groupType) => {
      const telegram = {
        findGroup: vi.fn().mockResolvedValue({
          familyId: "family-1",
          groupId: "group-1",
          telegramChatId: "-1001",
          toolAllowlist: [],
          type: groupType,
        }),
        findIdentity: vi.fn(),
      };
      const authorize = createTelegramVoiceAuthorizer(telegram);

      await expect(authorize({
        chat: { id: "-1001", type: "supergroup" },
        from: { id: "202", isBot: false },
      })).resolves.toBe(false);
      expect(telegram.findIdentity).not.toHaveBeenCalled();
    },
  );
});
