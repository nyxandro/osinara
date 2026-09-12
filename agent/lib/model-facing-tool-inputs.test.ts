/**
 * Model-facing tool input hardening tests.
 *
 * Constructs covered:
 * - Former root-union tools reject malformed model payloads with stable actionable errors.
 * - Invalid input stops before authorization, repository writes, or external model calls.
 * - `executeInvalidToolInput`: invokes heterogeneous tool signatures through a safe `never` input.
 */
import type { ToolContext, ToolDefinition } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const toolCalls = vi.hoisted(() => ({
  approveInvitation: vi.fn(),
  createInvitation: vi.fn(),
  deleteMemory: vi.fn(),
  deletePreference: vi.fn(),
  inspectImage: vi.fn(),
  importAttachment: vi.fn(),
  registerGroup: vi.fn(),
  reminderCreate: vi.fn(),
  reminderUpdate: vi.fn(),
  removeRegistration: vi.fn(),
  updateMemory: vi.fn(),
}));

vi.mock("./behavior-preference-repository.js", () => ({
  behaviorPreferenceRepository: { delete: toolCalls.deletePreference, set: vi.fn() },
}));
vi.mock("./family-context.js", () => ({
  requireOwner: vi.fn(),
  requirePrivateTelegramOwner: vi.fn(() => ({
    familyId: "family-1",
    telegramChatId: "101",
    userId: "owner-1",
  })),
}));
vi.mock("./family-repository.js", () => ({
  familyRepository: {
    approveInvitation: toolCalls.approveInvitation,
    createInvitation: toolCalls.createInvitation,
    markInvitationDelivered: vi.fn(),
    markInvitationDeliveryStarted: vi.fn(),
  },
}));
vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: vi.fn(() => ({ familyId: "family-1", scopes: ["personal"] })),
  requireWritableScope: vi.fn((_: unknown, scope: string) => scope),
}));
vi.mock("./memory-repository.js", () => ({
  memoryRepository: { delete: toolCalls.deleteMemory, update: toolCalls.updateMemory },
}));
vi.mock("./reminders/reminder-context.js", () => ({
  requireReminderAuthorization: vi.fn(() => ({
    familyId: "family-1",
    telegramChatType: "private",
    userId: "user-1",
  })),
}));
vi.mock("./reminders/reminder-repository.js", () => ({
  reminderRepository: {
    configureNotifications: vi.fn(),
    create: toolCalls.reminderCreate,
    delete: vi.fn(),
    getNotificationSettings: vi.fn(),
    update: toolCalls.reminderUpdate,
  },
}));
vi.mock("./telegram-delivery.js", () => ({ deliverFamilyInvitation: vi.fn() }));
vi.mock("./attachments/telegram-attachment-materializer.js", () => ({
  materializeTelegramAttachment: toolCalls.importAttachment,
}));
vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: {
    registerGroup: toolCalls.registerGroup,
    removeRegistration: toolCalls.removeRegistration,
    updatePolicy: vi.fn(),
    updateSkills: vi.fn(),
  },
}));
vi.mock("./workspaces/workspace-context.js", () => ({
  requireWorkspaceAuthorization: vi.fn(() => ({ familyId: "family-1", userId: "user-1" })),
}));
vi.mock("./workspaces/workspace-image-inspection.js", () => ({
  inspectWorkspaceImage: toolCalls.inspectImage,
}));

import manageBehaviorPreference from "./tools/manage_behavior_preference.js";
import importTelegramAttachment from "./tools/import_telegram_attachment.js";
import manageFamilyInvitation from "./tools/manage_family_invitation.js";
import inspectWorkspaceImage from "./tools/inspect_workspace_image.js";
import manageMemory from "./tools/manage_memory.js";
import manageReminder from "./tools/manage_reminder.js";
import manageTelegramGroup from "./tools/manage_telegram_group.js";
import notificationSettings from "./tools/notification_settings.js";

const context = { callId: "call-1" } as ToolContext;

function executeInvalidToolInput(
  tool: Pick<ToolDefinition<never, unknown>, "execute">,
  input: never,
  toolContext: ToolContext,
) {
  // `never` is the shared safe input for this table because every case intentionally bypasses its schema.
  return tool.execute(input, toolContext);
}

describe("model-facing tool input hardening", () => {
  beforeEach(() => {
    for (const call of Object.values(toolCalls)) call.mockReset();
  });

  it.each([
    ["manage_reminder", manageReminder, /AGENT_REMINDER_INPUT_INVALID: Для manage_reminder передайте action/],
    [
      "notification_settings",
      notificationSettings,
      /AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID: Для notification_settings передайте action/,
    ],
    ["manage_memory", manageMemory, /AGENT_MEMORY_INPUT_INVALID: Для manage_memory передайте action/],
    [
      "manage_telegram_group",
      manageTelegramGroup,
      /AGENT_TELEGRAM_GROUP_INPUT_INVALID: Для manage_telegram_group передайте action/,
    ],
    [
      "manage_family_invitation",
      manageFamilyInvitation,
      /AGENT_FAMILY_INVITATION_INPUT_INVALID: Для manage_family_invitation передайте action/,
    ],
    [
      "manage_behavior_preference",
      manageBehaviorPreference,
      /AGENT_BEHAVIOR_PREFERENCE_INPUT_INVALID: Для manage_behavior_preference передайте action/,
    ],
    [
      "import_telegram_attachment",
      importTelegramAttachment,
      /AGENT_TELEGRAM_ATTACHMENT_IMPORT_INPUT_INVALID: Поле attachmentId обязательно/,
    ],
    [
      "inspect_workspace_image",
      inspectWorkspaceImage,
      /AGENT_WORKSPACE_IMAGE_INPUT_INVALID: Для inspect_workspace_image передайте ровно один источник/,
    ],
  ] as const)("%s returns an actionable input error for an empty payload", async (_name, tool, message) => {
    await expect(executeInvalidToolInput(tool, {} as never, context)).rejects.toThrowError(message);
  });

  it("explains the exact reminder recurrence shape when interval is missing", async () => {
    await expect(manageReminder.execute({
      action: "create",
      content: "Позвонить врачу",
      firstRunAt: "2026-08-01T10:00:00+03:00",
      recurrence: { unit: "weekly" },
      scope: "personal",
      timezone: "Europe/Moscow",
    } as never, context)).rejects.toThrowError(
      /AGENT_REMINDER_INPUT_INVALID: Для recurrence передайте null или объект \{"unit":"weekly","interval":1\}/,
    );
    expect(toolCalls.reminderCreate).not.toHaveBeenCalled();
  });

  it("rejects incomplete recurrence before writing a reminder", async () => {
    await expect(manageReminder.execute({
      action: "update",
      id: "00000000-0000-4000-8000-000000000001",
      recurrence: {},
    } as never, context)).rejects.toThrowError(
      /AGENT_REMINDER_INPUT_INVALID: Поле unit обязательно.*Пример: daily/u,
    );
    expect(toolCalls.reminderUpdate).not.toHaveBeenCalled();
  });

  it("never requests approval for trusted reminder mutations", () => {
    expect(manageReminder.approval).toBeUndefined();
  });

  it.each(["minutely", "hourly", "yearly"])("accepts %s recurrence for trusted reminders", async (unit) => {
    const recurrence = { unit, interval: 1 };
    const input = {
      action: "create", content: "Проверка", firstRunAt: "2026-09-12T18:00:00+03:00",
      recurrence, scope: "personal", timezone: "Europe/Moscow",
    };
    expect((manageReminder.inputSchema as z.ZodType).safeParse(input).success).toBe(true);
    await manageReminder.execute(input as never, context);
    expect(toolCalls.reminderCreate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ recurrence }));
    await manageReminder.execute({ action: "update", id: "00000000-0000-4000-8000-000000000001", recurrence } as never, context);
    expect(toolCalls.reminderUpdate).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ recurrence }));
    for (const interval of [0, -1, 0.5]) {
      await expect(manageReminder.execute({ ...input, recurrence: { unit, interval } } as never, context))
        .rejects.toMatchObject({ code: "AGENT_REMINDER_INPUT_INVALID" });
    }
  });

  it("ignores known create-only sibling fields on a recurrence update", async () => {
    toolCalls.reminderUpdate.mockResolvedValue({ recurrence: null });

    await expect(manageReminder.execute({
      action: "update",
      id: "00000000-0000-4000-8000-000000000001",
      recurrence: null,
      scope: "personal",
      timezone: "Europe/Moscow",
    }, context)).resolves.toEqual({ recurrence: null });

    expect(toolCalls.reminderUpdate).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-4000-8000-000000000001",
      {
        content: undefined,
        firstRunAt: undefined,
        operationKey: "call-1",
        recurrence: null,
      },
    );
  });

  it("accepts a group-scoped Telegram message ID for workspace image inspection", async () => {
    toolCalls.inspectImage.mockResolvedValue({ analysis: "Фото группы" });

    await expect(inspectWorkspaceImage.execute({
      question: "Что изображено?",
      scope: "group",
      telegramMessageId: "42",
    }, context)).resolves.toEqual({ analysis: "Фото группы" });

    expect(toolCalls.inspectImage).toHaveBeenCalledWith(
      { familyId: "family-1", userId: "user-1" },
      expect.objectContaining({
        question: "Что изображено?",
        scope: "group",
        telegramMessageId: "42",
      }),
    );
  });

  it("accepts attachmentId and rejects multiple image sources", async () => {
    toolCalls.inspectImage.mockResolvedValue({ analysis: "Фото группы" });

    await expect(inspectWorkspaceImage.execute({
      attachmentId: "00000000-0000-4000-8000-000000000041",
      question: "Что изображено?",
      scope: "group",
    }, context)).resolves.toEqual({ analysis: "Фото группы" });
    await expect(inspectWorkspaceImage.execute({
      attachmentId: "00000000-0000-4000-8000-000000000041",
      path: "group/image.png",
      question: "Что изображено?",
      scope: "group",
    }, context)).rejects.toThrowError(/AGENT_WORKSPACE_IMAGE_INPUT_INVALID/);
  });
});
