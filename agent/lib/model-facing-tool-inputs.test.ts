/**
 * Model-facing tool input hardening tests.
 *
 * Constructs covered:
 * - Former root-union tools reject malformed model payloads with stable actionable errors.
 * - Invalid input stops before authorization, repository writes, or external model calls.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toolCalls = vi.hoisted(() => ({
  approveInvitation: vi.fn(),
  createInvitation: vi.fn(),
  deleteMemory: vi.fn(),
  deletePreference: vi.fn(),
  inspectImage: vi.fn(),
  registerGroup: vi.fn(),
  reminderCreate: vi.fn(),
  removeGroup: vi.fn(),
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
    assertCurrentOwner: vi.fn(),
    createInvitation: toolCalls.createInvitation,
    markInvitationDelivered: vi.fn(),
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
    update: vi.fn(),
  },
}));
vi.mock("./telegram-delivery.js", () => ({ deliverFamilyInvitation: vi.fn() }));
vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: {
    registerGroup: toolCalls.registerGroup,
    removeGroup: toolCalls.removeGroup,
  },
}));
vi.mock("./workspaces/workspace-context.js", () => ({
  requireWorkspaceAuthorization: vi.fn(() => ({ familyId: "family-1", userId: "user-1" })),
}));
vi.mock("./workspaces/workspace-image-inspection.js", () => ({
  inspectWorkspaceImage: toolCalls.inspectImage,
}));

import manageBehaviorPreference from "../tools/manage_behavior_preference.js";
import manageFamilyInvitation from "../tools/manage_family_invitation.js";
import inspectWorkspaceImage from "../tools/inspect_workspace_image.js";
import manageMemory from "../tools/manage_memory.js";
import manageReminder from "../tools/manage_reminder.js";
import manageTelegramGroup from "../tools/manage_telegram_group.js";
import notificationSettings from "../tools/notification_settings.js";

const context = { callId: "call-1" } as ToolContext;

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
      "inspect_workspace_image",
      inspectWorkspaceImage,
      /AGENT_WORKSPACE_IMAGE_INPUT_INVALID: Для inspect_workspace_image передайте path или telegramMessageId/,
    ],
  ] as const)("%s returns an actionable input error for an empty payload", async (_name, tool, message) => {
    await expect(tool.execute({}, context)).rejects.toThrowError(message);
  });

  it("explains the exact reminder recurrence shape when interval is missing", async () => {
    await expect(manageReminder.execute({
      action: "create",
      content: "Позвонить врачу",
      firstRunAt: "2026-08-01T10:00:00+03:00",
      recurrence: { unit: "weekly" },
      scope: "personal",
      timezone: "Europe/Moscow",
    }, context)).rejects.toThrowError(
      /AGENT_REMINDER_INPUT_INVALID: Для recurrence передайте null или объект \{"unit":"weekly","interval":1\}/,
    );
    expect(toolCalls.reminderCreate).not.toHaveBeenCalled();
  });
});
