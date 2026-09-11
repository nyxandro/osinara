/**
 * Consolidated model-facing action schema tests.
 *
 * Constructs:
 * - Object-shaped schemas for every transport-sensitive application tool.
 * - Semantic action validation is intentionally covered by execute-level tests.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import manageBehaviorPreference from "./tools/manage_behavior_preference.js";
import manageAgentSchedule from "./tools/manage_agent_schedule.js";
import manageFamilyInvitation from "./tools/manage_family_invitation.js";
import inspectWorkspaceImage from "./tools/inspect_workspace_image.js";
import manageMemory from "./tools/manage_memory.js";
import manageReminder from "./tools/manage_reminder.js";
import { EXTERNAL_GROUP_REMINDER_TOOLS } from "./tool-policy/external-group-reminder-tools.js";
import manageTelegramGroup from "./tools/manage_telegram_group.js";
import notificationSettings from "./tools/notification_settings.js";

const ID = "00000000-0000-4000-8000-000000000001";
const MEMORY_REF = "mem_00000000000000000000000000000001";

function schemaOf(tool: { inputSchema: unknown }): z.ZodType {
  return tool.inputSchema as z.ZodType;
}

const transportSensitiveTools = {
  externalGroupManageReminder: EXTERNAL_GROUP_REMINDER_TOOLS.manage_reminder!,
  inspectWorkspaceImage,
  manageAgentSchedule,
  manageBehaviorPreference,
  manageFamilyInvitation,
  manageMemory,
  manageReminder,
  manageTelegramGroup,
  notificationSettings,
} as const;

function jsonSchemaOf(tool: { inputSchema: unknown }): Record<string, unknown> {
  return z.toJSONSchema(schemaOf(tool)) as Record<string, unknown>;
}

describe("consolidated tool action schemas", () => {
  it("publishes object-shaped schemas without root combinators for model transports", () => {
    for (const [toolName, tool] of Object.entries(transportSensitiveTools)) {
      const jsonSchema = jsonSchemaOf(tool);

      expect(jsonSchema, toolName).toMatchObject({ type: "object" });
      expect(jsonSchema, toolName).not.toHaveProperty("oneOf");
      expect(jsonSchema, toolName).not.toHaveProperty("anyOf");
      expect(jsonSchema, toolName).not.toHaveProperty("allOf");
    }
  });

  it("accepts every memory mutation shape through the model-facing schema", () => {
    const schema = schemaOf(manageMemory);

    expect(schema.safeParse({ action: "edit", content: "Исправлено", memoryRef: MEMORY_REF }).success)
      .toBe(true);
    expect(schema.safeParse({ action: "delete", memoryRef: MEMORY_REF }).success).toBe(true);
    expect(schema.safeParse({ action: "undo", memoryRef: MEMORY_REF }).success).toBe(true);
    expect(schema.safeParse({ action: "edit", memoryRef: MEMORY_REF }).success).toBe(true);
  });

  it("accepts explicit reminder mutation shapes through the model-facing schema", () => {
    const schema = schemaOf(manageReminder);

    expect(schema.safeParse({
      action: "create",
      content: "Позвонить",
      firstRunAt: "2026-08-01T10:00:00+03:00",
      recurrence: null,
      scope: "personal",
      timezone: "Europe/Moscow",
    }).success).toBe(true);
    expect(schema.safeParse({ action: "pause", id: ID }).success).toBe(true);
    expect(schema.safeParse({ action: "resume", id: ID }).success).toBe(true);
    expect(schema.safeParse({ action: "delete", id: ID }).success).toBe(true);
    expect(schema.safeParse({ action: "toggle", id: ID }).success).toBe(false);
    expect(schema.safeParse({ id: ID }).success).toBe(false);
    expect(schema.safeParse({ action: "update", id: ID, recurrence: null }).success).toBe(true);
    expect(schema.safeParse({
      action: "update",
      id: ID,
      recurrence: { interval: 1, unit: "daily" },
    }).success).toBe(true);
    expect(schema.safeParse({ action: "update", id: ID, recurrence: {} }).success).toBe(false);
    expect(schema.safeParse({
      action: "update",
      id: ID,
      recurrence: { interval: 1 },
    }).success).toBe(false);
  });

  it("publishes the complete external-group policy update fields in the model-facing schema", () => {
    const schema = schemaOf(manageTelegramGroup);
    const jsonSchema = jsonSchemaOf(manageTelegramGroup);

    expect(schema.safeParse({
      action: "update_policy",
      messageMode: "all",
      telegramChatId: "-1001234567890",
      toolAllowlist: ["search_memories"],
    }).success).toBe(true);
    const properties = jsonSchema.properties as Record<string, { description?: string }>;
    expect(properties.action?.description).toContain("Сначала выберите ровно один action");
    expect(properties.action?.description).toContain("update_skills");
    expect(properties.registration?.description).toContain("только при action=register");
    expect(properties.telegramChatId?.description).toContain("status не передавайте");
    expect(properties.toolAllowlist?.description).toContain("только при action=update_policy");
  });

  it("publishes an object-shaped agent schedule schema for model transports", () => {
    const schema = schemaOf(manageAgentSchedule);
    const jsonSchema = jsonSchemaOf(manageAgentSchedule);

    expect(jsonSchema).toMatchObject({ type: "object" });
    expect(jsonSchema).not.toHaveProperty("oneOf");
    expect(schema.safeParse({
      action: "create",
      firstRunAt: "2026-07-15T23:33:00+03:00",
      recurrence: { interval: 1, kind: "daily" },
      scenarioPrompt: "Собери сводку по новым моделям ИИ.",
      scope: "personal",
      timezone: "Europe/Moscow",
      title: "Дайджест: новые модели ИИ",
      userRequest: "ежедневно в 23:33 МСК получать сводку про новые модели ИИ",
    }).success).toBe(true);
  });

  it("separates notification reads from explicit writes", () => {
    const schema = schemaOf(notificationSettings);

    expect(schema.safeParse({ action: "get" }).success).toBe(true);
    expect(schema.safeParse({
      action: "set",
      quietEnd: "08:00",
      quietStart: "22:00",
      timezone: "Europe/Moscow",
    }).success).toBe(true);
    expect(schema.safeParse({ action: "set", timezone: "Europe/Moscow" }).success).toBe(true);
  });

  it("accepts behavior, invitation, and group management actions", () => {
    expect(schemaOf(manageBehaviorPreference).safeParse({
      action: "replace",
      content: "Отвечай без шуток.",
      expectedRevision: 0,
    }).success).toBe(true);
    expect(schemaOf(manageFamilyInvitation).safeParse({ action: "create" }).success).toBe(true);
    expect(schemaOf(manageFamilyInvitation).safeParse({
      action: "approve",
      candidateDisplayName: "Анна",
      candidateTelegramUserId: "123",
      invitationId: ID,
    }).success).toBe(true);
    expect(schemaOf(manageTelegramGroup).safeParse({
      action: "remove",
      telegramChatId: "-1001234567890",
    }).success).toBe(true);
  });
});
