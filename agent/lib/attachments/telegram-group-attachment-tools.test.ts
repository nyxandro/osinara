/**
 * Model-facing family Telegram attachment tool routing tests.
 *
 * Constructs covered:
 * - `list_telegram_attachments`: confines lookup to the verified current family group topic.
 */
import type { ToolContext } from "../../runtime/tool.js";
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("./telegram-group-attachment-repository.js", () => ({
  telegramGroupAttachmentRepository: { list: calls.list },
}));
vi.mock("../workspaces/workspace-context.js", () => ({
  requireTelegramDeliveryTarget: vi.fn(() => ({ chatId: "-1001", messageThreadId: 42 })),
  requireWorkspaceAuthorization: vi.fn(() => ({
    familyId: "family-1",
    groupId: "group-1",
    groupType: "family_private",
    role: "member",
    telegramChatType: "supergroup",
    userId: "user-1",
  })),
}));

import listTelegramAttachments from "../tools/list_telegram_attachments.js";

describe("family Telegram attachment tools", () => {
  it("lists references only from the verified current topic", async () => {
    calls.list.mockResolvedValue({
      items: [{ attachmentId: "attachment-1" }],
      nextCursor: "cursor-1",
    });

    await expect(
      listTelegramAttachments.execute({
        cursor: "cursor-0",
        fileName: "отчёт.pdf",
        limit: 12,
      }, { callId: "call-1" } as ToolContext),
    ).resolves.toEqual({
      items: [{ attachmentId: "attachment-1" }],
      nextCursor: "cursor-1",
    });
    expect(calls.list).toHaveBeenCalledWith(expect.objectContaining({
      familyId: "family-1",
      groupId: "group-1",
    }), {
      cursor: "cursor-0",
      fileName: "отчёт.pdf",
      limit: 12,
      messageThreadId: "42",
    });
  });
});
