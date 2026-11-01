/**
 * Telegram voice authorization tests.
 *
 * Constructs covered:
 * - `createTelegramVoiceAuthorizer`: a private chat and the family group transcribe every voice note of
 *   a family member; an external group only one addressed to the agent, and in owner-only mode only
 *   the owner's.
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
      authorize({ chat: { id: "101", type: "private" }, from: { id: "101", isBot: false } }, { addressed: true }),
    ).resolves.toBe(true);
    expect(telegram.findGroup).not.toHaveBeenCalled();
  });

  it("denies an unknown private caller before transcription", async () => {
    const authorize = createTelegramVoiceAuthorizer({
      findGroup: vi.fn(),
      findIdentity: vi.fn().mockResolvedValue(null),
    });

    await expect(
      authorize({ chat: { id: "101", type: "private" }, from: { id: "101", isBot: false } }, { addressed: true }),
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
      }, { addressed: true }),
    ).resolves.toBe(false);
  });

  it("transcribes a family member's voice in the family group even when it addresses nobody", async () => {
    const authorize = createTelegramVoiceAuthorizer({
      findGroup: vi.fn().mockResolvedValue({
        familyId: "family-1", groupId: "group-1", messageMode: "all", telegramChatId: "-1001", toolAllowlist: [], type: "family_private",
      }),
      findIdentity: vi.fn().mockResolvedValue({ familyId: "family-1", role: "member", userId: "user-1" }),
    });

    await expect(authorize({ chat: { id: "-1001", type: "supergroup" }, from: { id: "101", isBot: false } }, { addressed: false }))
      .resolves.toBe(true);
  });

  it("transcribes external voice only when it addresses the agent, without an identity lookup", async () => {
    const telegram = {
      findGroup: vi.fn().mockResolvedValue({
        familyId: "family-1", groupId: "group-1", messageMode: "all", telegramChatId: "-1001", toolAllowlist: [], type: "external" as const,
      }),
      findIdentity: vi.fn(),
    };
    const authorize = createTelegramVoiceAuthorizer(telegram);
    const voice = { chat: { id: "-1001", type: "supergroup" as const }, from: { id: "202", isBot: false } };

    await expect(authorize(voice, { addressed: false })).resolves.toBe(false);
    await expect(authorize(voice, { addressed: true })).resolves.toBe(true);
    expect(telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("transcribes addressed external voice in owner-only mode only for the owner", async () => {
    const findIdentity = vi.fn();
    const authorize = createTelegramVoiceAuthorizer({
      findGroup: vi.fn().mockResolvedValue({
        familyId: "family-1", groupId: "group-1", messageMode: "owner_only", telegramChatId: "-1001", toolAllowlist: [], type: "external",
      }),
      findIdentity,
    });
    const voice = { chat: { id: "-1001", type: "supergroup" as const }, from: { id: "202", isBot: false } };

    findIdentity.mockResolvedValueOnce(null);
    await expect(authorize(voice, { addressed: true })).resolves.toBe(false);
    findIdentity.mockResolvedValueOnce({ familyId: "family-1", role: "owner", userId: "owner-1" });
    await expect(authorize(voice, { addressed: true })).resolves.toBe(true);
  });
});
