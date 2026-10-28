/**
 * Workspace files inside a reminder.
 *
 * Constructs covered:
 * - The text is refused when it is written if a file will not reach the reminder's chat: a family
 *   group shows only the family folder, a private chat the person's and the family's. The writer's
 *   files are measured with their rights as in their private chat, wherever they write from.
 * - At delivery the files are read with the author's rights in the reminder's chat; a public chat's
 *   reminder reads only that chat's folder; a reminder without a known author reads nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const resolver = vi.hoisted(() => ({ load: vi.fn(), measure: vi.fn() }));
vi.mock("../answer-files/answer-file-resolution.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../answer-files/answer-file-resolution.js")>(),
  answerFileResolver: resolver,
}));

import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import type { ClaimedReminder } from "./reminder-dispatch-repository.js";
import { reminderWorkspaceAuthorization, reminderWriterRights, requireReminderFiles } from "./reminder-files.js";

const FAMILY_ID = "00000000-0000-4000-8000-000000000010";
const AUTHOR_ID = "00000000-0000-4000-8000-000000000020";
const GROUP_ID = "00000000-0000-4000-8000-000000000012";

const job: ClaimedReminder = {
  addresseeTelegramUserId: "202",
  authorRole: "member",
  authorUserId: AUTHOR_ID,
  buttons: null,
  content: "Собрать документы",
  delayed: false,
  dueAt: "2026-07-13T06:00:00.000Z",
  familyId: FAMILY_ID,
  forumTopicId: null,
  groupId: GROUP_ID,
  id: "00000000-0000-4000-8000-000000000001",
  leaseToken: "00000000-0000-4000-8000-000000000002",
  messageThreadId: null,
  ownerUserId: null,
  scope: "family",
  telegramChatId: "-1001",
  telegramChatType: "supergroup",
  timezone: "Europe/Moscow",
};

function measured(path: string, scope: "family" | "group" | "personal") {
  return { file: { byteSize: 3, fileName: path.split("/").at(-1)!, path, scope }, ok: true };
}

describe("reminder file check", () => {
  afterEach(() => vi.resetAllMocks());

  it("refuses a personal file in a reminder for the family group", async () => {
    await expect(requireReminderFiles({
      content: "Собрать документы\n\n![](/workspace/personal/passport.pdf)",
      errorCode: "AGENT_REMINDER_INPUT_INVALID",
      rights: () => null,
      scope: "family",
    })).rejects.toMatchObject({
      code: "AGENT_REMINDER_INPUT_INVALID",
      message: expect.stringContaining("/workspace/personal/passport.pdf: напоминание придёт в чат, где эта папка недоступна; подходит /workspace/family/..."),
    });
    expect(resolver.measure).not.toHaveBeenCalled();
  });

  it("lets a personal reminder show a family file, measured with the writer's rights", async () => {
    const rights = reminderWriterRights({
      familyId: FAMILY_ID, forumTopicId: null, groupId: GROUP_ID, groupType: "family_private", messageThreadId: null,
      role: "owner", telegramChatId: "-1001", telegramChatType: "supergroup", userId: AUTHOR_ID,
    });
    resolver.measure.mockResolvedValue(measured("lists/shop.pdf", "family"));

    await expect(requireReminderFiles({
      content: "Купить продукты\n\n![Список](/workspace/family/lists/shop.pdf)",
      errorCode: "AGENT_REMINDER_INPUT_INVALID",
      rights: () => rights,
      scope: "personal",
    })).resolves.toBeUndefined();
    // Written from the family group, the reminder still reaches the private chat.
    expect(rights).toEqual({
      familyId: FAMILY_ID, groupId: null, groupType: null, role: "owner", telegramChatType: "private", userId: AUTHOR_ID,
    } satisfies WorkspaceAuthorization);
    expect(resolver.measure).toHaveBeenCalledWith(rights, expect.objectContaining({ path: "lists/shop.pdf", scope: "family" }));
  });

  it("checks nothing for a reminder without files", async () => {
    const rights = vi.fn(() => null);

    await requireReminderFiles({ content: "Позвонить врачу", errorCode: "AGENT_REMINDER_INPUT_INVALID", rights, scope: "group" });

    expect(rights).not.toHaveBeenCalled();
  });
});

describe("reminder file rights at delivery", () => {
  it("reads a family reminder's files as its author in the family group", () => {
    expect(reminderWorkspaceAuthorization(job)).toEqual({
      familyId: FAMILY_ID, groupId: GROUP_ID, groupType: "family_private", role: "member",
      telegramChatType: "supergroup", userId: AUTHOR_ID,
    });
  });

  it("reads a personal reminder's files as its author in a private chat", () => {
    expect(reminderWorkspaceAuthorization({ ...job, groupId: null, scope: "personal", telegramChatType: "private" })).toEqual({
      familyId: FAMILY_ID, groupId: null, groupType: null, role: "member", telegramChatType: "private", userId: AUTHOR_ID,
    });
  });

  it("reads a public chat's reminder files only from that chat's folder", () => {
    expect(reminderWorkspaceAuthorization({ ...job, authorRole: null, authorUserId: null, scope: "group", telegramChatType: "group" }))
      .toEqual({
        familyId: FAMILY_ID, groupId: GROUP_ID, groupType: "external", role: "external", telegramChatType: "group", userId: null,
      });
  });

  it("refuses to guess rights for a family reminder without its author", () => {
    expect(() => reminderWorkspaceAuthorization({ ...job, authorRole: null }))
      .toThrow(expect.objectContaining({ code: "AGENT_REMINDER_FILES_CONTEXT_INVALID" }));
  });
});
