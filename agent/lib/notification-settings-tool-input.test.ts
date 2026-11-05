/**
 * Notification settings model-input contract tests.
 *
 * Constructs covered:
 * - Machine-visible required action enum in an object schema.
 * - Semantic validation before execution, without a user approval gate.
 * - Explicit safe handling of MiniMax sibling-field materialization.
 * - Complete payload and bounded-correction guidance in the tool description.
 * - Where a zone came from (#451): explicit source, a basis for the agent's reading, quiet hours kept
 *   when left out.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { configureNotifications, getNotificationSettings } = vi.hoisted(() => ({
  configureNotifications: vi.fn(),
  getNotificationSettings: vi.fn(),
}));

vi.mock("./reminders/reminder-context.js", () => ({
  requireReminderAuthorization: vi.fn(() => ({
    telegramChatType: "private",
    userId: "user-1",
  })),
}));
vi.mock("./reminders/reminder-repository.js", () => ({
  reminderRepository: { configureNotifications, getNotificationSettings },
}));

import notificationSettings from "./tools/notification_settings.js";

const context = { callId: "call-1" } as ToolContext;

describe("notification_settings model input", () => {
  beforeEach(() => {
    configureNotifications.mockReset();
    getNotificationSettings.mockReset();
    getNotificationSettings.mockResolvedValue({ timezone: "Europe/Moscow" });
  });

  it("publishes a required action enum in an object schema", () => {
    const schema = z.toJSONSchema(notificationSettings.inputSchema as z.ZodType) as {
      properties: Record<string, { enum?: string[] }>;
      required?: string[];
      type?: string;
    };

    expect(schema.type).toBe("object");
    expect(schema.required).toContain("action");
    expect(schema.properties.action?.enum).toEqual(["get", "set"]);
  });

  it("does not require approval to configure the first reminder", () => {
    expect(notificationSettings.approval).toBeUndefined();
  });

  it("rejects a set that does not say where the zone came from", async () => {
    const invalid = { action: "set", timezone: "Europe/Moscow" };

    await expect(notificationSettings.execute(invalid as never, context)).rejects.toThrowError(
      /AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID.*source/u,
    );
    expect(configureNotifications).not.toHaveBeenCalled();
  });

  it("requires the basis of a zone the agent read from a sign", async () => {
    await expect(notificationSettings.execute(
      { action: "set", source: "agent", timezone: "Europe/Moscow" } as never,
      context,
    )).rejects.toThrowError(/AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID.*basis/u);
    expect(configureNotifications).not.toHaveBeenCalled();
  });

  it("keeps quiet hours when they are left out and refuses half a pair", async () => {
    configureNotifications.mockResolvedValue({ timezone: "Asia/Yerevan" });
    await notificationSettings.execute({ action: "set", source: "person", timezone: "Asia/Yerevan" }, context);
    expect(configureNotifications).toHaveBeenCalledWith(expect.anything(), {
      basis: null,
      source: "person",
      timezone: "Asia/Yerevan",
    });

    await expect(notificationSettings.execute(
      { action: "set", quietStart: "22:00", source: "person", timezone: "Asia/Yerevan" } as never,
      context,
    )).rejects.toThrowError(/AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID.*quietStart/u);
  });

  it("ignores only known set siblings when MiniMax materializes them for get", async () => {
    const input = {
      action: "get",
      quietEnd: "08:00",
      quietStart: "22:00",
      timezone: "Europe/Moscow",
    } as const;

    await expect(notificationSettings.execute(input, context)).resolves.toEqual({
      timezone: "Europe/Moscow",
    });
    expect(getNotificationSettings).toHaveBeenCalledTimes(1);
    expect(configureNotifications).not.toHaveBeenCalled();
  });

  it("rejects unpublished fields before execution", async () => {
    await expect(notificationSettings.execute({ action: "get", timezoneId: "Europe/Moscow" } as never, context)).rejects.toThrowError(
      /AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID.*timezoneId/u,
    );
  });

  it("documents every payload field and constraint without defaults", () => {
    const description = notificationSettings.description;

    for (const fragment of [
      '{"action":"get"}',
      '"action":"set"',
      "timezone",
      "quietStart",
      "quietEnd",
      "null",
      "HH:MM",
      "source",
      "basis",
      "never from the language",
    ]) expect(description).toContain(fragment);
  });
});
