/**
 * Consolidated model-facing action schema tests.
 *
 * Constructs:
 * - Explicit discriminated actions for every consolidated application tool.
 * - Rejection of incomplete action payloads before trusted execution.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import manageBehaviorPreference from "../tools/manage_behavior_preference.js";
import manageFamilyInvitation from "../tools/manage_family_invitation.js";
import manageMemory from "../tools/manage_memory.js";
import manageReminder from "../tools/manage_reminder.js";
import manageTask from "../tools/manage_task.js";
import manageTelegramGroup from "../tools/manage_telegram_group.js";
import notificationSettings from "../tools/notification_settings.js";

const ID = "00000000-0000-4000-8000-000000000001";

function schemaOf(tool: { inputSchema: unknown }): z.ZodType {
  return tool.inputSchema as z.ZodType;
}

describe("consolidated tool action schemas", () => {
  it("accepts every memory mutation and rejects an incomplete edit", () => {
    const schema = schemaOf(manageMemory);

    expect(schema.safeParse({ action: "edit", content: "Исправлено", id: ID }).success).toBe(true);
    expect(schema.safeParse({ action: "delete", id: ID }).success).toBe(true);
    expect(schema.safeParse({ action: "undo", id: ID }).success).toBe(true);
    expect(schema.safeParse({ action: "edit", id: ID }).success).toBe(false);
  });

  it("accepts every task mutation and requires complete replacement fields", () => {
    const schema = schemaOf(manageTask);

    expect(schema.safeParse({
      action: "create",
      assigneeUserId: ID,
      details: null,
      dueAt: null,
      scope: "personal",
      timezone: null,
      title: "Задача",
    }).success).toBe(true);
    expect(schema.safeParse({
      action: "update",
      details: null,
      dueAt: null,
      id: ID,
      timezone: null,
      title: "Новая задача",
    }).success).toBe(true);
    expect(schema.safeParse({ action: "complete", id: ID }).success).toBe(true);
    expect(schema.safeParse({ action: "delete", id: ID }).success).toBe(true);
    expect(schema.safeParse({ action: "update", id: ID }).success).toBe(false);
  });

  it("accepts explicit reminder mutations without a non-idempotent toggle", () => {
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
  });

  it("separates notification reads from approved writes", () => {
    const schema = schemaOf(notificationSettings);

    expect(schema.safeParse({ action: "get" }).success).toBe(true);
    expect(schema.safeParse({
      action: "set",
      quietEnd: "08:00",
      quietStart: "22:00",
      timezone: "Europe/Moscow",
    }).success).toBe(true);
    expect(schema.safeParse({ action: "set", timezone: "Europe/Moscow" }).success).toBe(false);
  });

  it("accepts behavior, invitation, and group management actions", () => {
    expect(schemaOf(manageBehaviorPreference).safeParse({
      action: "reset",
      preference: "tone",
      scope: "personal",
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
