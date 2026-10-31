/**
 * Telegram avatar inspection tests, through the public image inspector.
 *
 * Constructs covered:
 * - `createWorkspaceImageInspector` with `avatarOfSequence`: the author of a message of the current
 *   chat is looked up after the live scope check, their current avatar goes to vision with the
 *   question and is never written to the workspace.
 * - A person without a visible avatar is an answer, not a failure; a bot is a participant too.
 * - A channel, the agent itself, an unknown message number and a scope of another chat stop before
 *   Telegram is asked.
 */
import { describe, expect, it, vi } from "vitest";

import { createWorkspaceImageInspector } from "../workspaces/workspace-image-inspection.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import type { TelegramAvatarAuthor } from "./telegram-avatar-author-repository.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PHOTO = { fileId: "file-640", fileUniqueId: "unique-640", height: 640, size: 12, width: 640 };
const privateChat: WorkspaceAuthorization = {
  familyId: "family-1",
  groupId: null,
  groupType: null,
  role: "owner",
  telegramChatType: "private",
  userId: "user-1",
};
const externalGroup: WorkspaceAuthorization = {
  familyId: "family-1",
  groupId: "group-1",
  groupType: "external",
  role: "external",
  telegramChatType: "supergroup",
  userId: null,
};
const human: TelegramAvatarAuthor = {
  actorKind: "user",
  senderDisplayName: "Алексей",
  senderUsername: "lexa",
  telegramUserId: "101",
};

function inspector(input: {
  analyze?: ReturnType<typeof vi.fn>;
  author?: TelegramAvatarAuthor | null;
  lookup?: ReturnType<typeof vi.fn>;
}) {
  const calls = {
    analyze: input.analyze ?? vi.fn().mockResolvedValue("На аватарке мужчина в очках."),
    authorizeScope: vi.fn(async () => undefined),
    download: vi.fn().mockResolvedValue(JPEG),
    findAvatarAuthor: vi.fn().mockResolvedValue(input.author === undefined ? human : input.author),
    lookup: input.lookup ?? vi.fn().mockResolvedValue({ photo: PHOTO, status: "photo" }),
    readBinary: vi.fn(),
  };
  const inspect = createWorkspaceImageInspector({
    analyze: calls.analyze,
    authorizeScope: calls.authorizeScope,
    avatarSource: { download: calls.download, lookup: calls.lookup },
    downloadTelegramAttachment: vi.fn(),
    findAvatarAuthor: calls.findAvatarAuthor,
    findTelegramAttachment: vi.fn(),
    readBinary: calls.readBinary,
    readTelegramInboxAttachment: vi.fn(),
  });
  return { calls, inspect };
}

describe("avatar inspection", () => {
  it("shows vision the current avatar of the author of a message in this chat without saving it", async () => {
    const { calls, inspect } = inspector({});

    await expect(inspect(externalGroup, {
      avatarOfSequence: "53247",
      question: "Есть ли на аватарке человек? Опиши внешность",
      scope: "group",
    })).resolves.toEqual({
      analysis: "На аватарке мужчина в очках.",
      scope: "group",
      source: {
        avatarOfSequence: "53247",
        kind: "telegram_avatar",
        mediaType: "image/jpeg",
        senderDisplayName: "Алексей",
        senderUsername: "lexa",
        size: JPEG.byteLength,
      },
    });
    expect(calls.authorizeScope).toHaveBeenCalledWith(externalGroup, "group");
    expect(calls.findAvatarAuthor).toHaveBeenCalledWith(externalGroup, "53247");
    expect(calls.lookup).toHaveBeenCalledWith("101");
    expect(calls.download).toHaveBeenCalledWith(PHOTO);
    expect(calls.analyze).toHaveBeenCalledWith(expect.objectContaining({
      bytes: JPEG,
      mediaType: "image/jpeg",
      question: "Есть ли на аватарке человек? Опиши внешность",
    }));
    expect(calls.readBinary).not.toHaveBeenCalled();
  });

  it("answers that the avatar is absent or hidden instead of failing, without a vision call", async () => {
    const { calls, inspect } = inspector({ lookup: vi.fn().mockResolvedValue({ status: "none" }) });

    await expect(inspect(privateChat, {
      avatarOfSequence: "12",
      question: "Как я выгляжу?",
      scope: "personal",
    })).resolves.toEqual({
      avatar: "missing",
      reason: "У этого человека нет аватарки или она скрыта от ботов настройками приватности Telegram.",
      scope: "personal",
      source: {
        avatarOfSequence: "12",
        kind: "telegram_avatar",
        senderDisplayName: "Алексей",
        senderUsername: "lexa",
      },
    });
    expect(calls.analyze).not.toHaveBeenCalled();
  });

  it("reads the avatar of a bot that writes in the chat", async () => {
    const { calls, inspect } = inspector({ author: { ...human, actorKind: "telegram_bot", telegramUserId: "202" } });

    await expect(inspect(externalGroup, {
      avatarOfSequence: "7",
      question: "Что на аватарке?",
      scope: "group",
    })).resolves.toMatchObject({ analysis: "На аватарке мужчина в очках." });
    expect(calls.lookup).toHaveBeenCalledWith("202");
  });

  it.each([
    ["a channel", { ...human, actorKind: "telegram_channel", telegramUserId: null }],
    ["the agent itself", { ...human, actorKind: "agent_self", telegramUserId: null }],
  ] as const)("refuses %s before asking Telegram", async (_name, author) => {
    const { calls, inspect } = inspector({ author });

    await expect(inspect(externalGroup, {
      avatarOfSequence: "7",
      question: "Что на аватарке?",
      scope: "group",
    })).rejects.toMatchObject({ contract: { code: "AGENT_TELEGRAM_AVATAR_NOT_A_PERSON", retryable: false } });
    expect(calls.lookup).not.toHaveBeenCalled();
  });

  it("refuses a message number that is not in this chat", async () => {
    const { calls, inspect } = inspector({ author: null });

    await expect(inspect(externalGroup, {
      avatarOfSequence: "999999",
      question: "Что на аватарке?",
      scope: "group",
    })).rejects.toMatchObject({ contract: { code: "AGENT_TELEGRAM_AVATAR_SOURCE_NOT_FOUND", retryable: true } });
    expect(calls.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["a private chat", privateChat, "family"],
    ["an external group", externalGroup, "personal"],
    ["the family group", { ...externalGroup, groupType: "family_private", role: "owner", userId: "user-1" }, "group"],
  ] as const)("asks for the scope of the current chat in %s", async (_name, auth, scope) => {
    const { calls, inspect } = inspector({});

    await expect(inspect(auth as WorkspaceAuthorization, {
      avatarOfSequence: "7",
      question: "Что на аватарке?",
      scope,
    })).rejects.toMatchObject({ contract: { code: "AGENT_TELEGRAM_AVATAR_SCOPE_INVALID", field: "scope", retryable: true } });
    expect(calls.findAvatarAuthor).not.toHaveBeenCalled();
  });

  it("does not look up the author when live access to the chat scope is gone", async () => {
    const { calls, inspect } = inspector({});
    calls.authorizeScope.mockRejectedValueOnce(new Error("AGENT_WORKSPACE_ACCESS_DENIED: Нет доступа"));

    await expect(inspect(externalGroup, {
      avatarOfSequence: "7",
      question: "Что на аватарке?",
      scope: "group",
    })).rejects.toThrowError(/AGENT_WORKSPACE_ACCESS_DENIED/);
    expect(calls.findAvatarAuthor).not.toHaveBeenCalled();
  });
});
