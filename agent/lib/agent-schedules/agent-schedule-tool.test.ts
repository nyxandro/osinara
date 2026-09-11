/**
 * Agent schedule tool contract tests.
 *
 * Constructs covered:
 * - Model-facing JSON Schema exposes actions and exact recurrence variants without a root union.
 * - Approval and execution share fail-closed semantic validation.
 * - `manage_agent_schedule.create`: routes a valid model payload into the repository boundary.
 * - `manage_agent_schedule.update`: ignores only proven MiniMax create-only sibling fields.
 * - ID-only actions reject every sibling field.
 * - Tool guidance publishes exact action payloads and forbids delete/recreate workarounds.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { createSchedule, deleteSchedule, runScheduleNow, updateSchedule } = vi.hoisted(() => ({
  createSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runScheduleNow: vi.fn(),
  updateSchedule: vi.fn(),
}));

vi.mock("./agent-schedule-context.js", () => ({
  requireAgentScheduleAuthorization: () => ({
    familyId: "family-1",
    groupId: null,
    groupType: null,
    messageThreadId: null,
    role: "member",
    telegramChatId: "101",
    telegramChatType: "private",
    telegramUserId: "telegram-101",
    userId: "user-1",
  }),
}));
vi.mock("./agent-schedule-repository.js", () => ({
  agentScheduleRepository: {
    create: createSchedule,
    delete: deleteSchedule,
    runNow: runScheduleNow,
    update: updateSchedule,
  },
}));

import manageAgentSchedule from "../tools/manage_agent_schedule.js";

const context = { callId: "call-1" } as ToolContext;
const scheduleId = "00000000-0000-4000-8000-000000000001";
const validDailyCreatePayload = {
  action: "create",
  firstRunAt: "2026-07-15T23:33:00+03:00",
  recurrence: { interval: 1, kind: "daily" },
  scenarioPrompt: "Собери главные новости о новых ИИ-моделях за последние 24 часа.",
  scope: "personal",
  timezone: "Europe/Moscow",
  title: "Дайджест: новые модели ИИ",
  userRequest: "ежедневно в 23:33 МСК получать сводку про новые модели ИИ",
} as const;

describe("manage_agent_schedule", () => {
  beforeEach(() => {
    createSchedule.mockReset();
    deleteSchedule.mockReset();
    runScheduleNow.mockReset();
    updateSchedule.mockReset();
    createSchedule.mockResolvedValue({ id: "schedule-1" });
    deleteSchedule.mockResolvedValue(true);
    runScheduleNow.mockResolvedValue({ id: scheduleId });
    updateSchedule.mockResolvedValue({ id: scheduleId });
  });

  it("publishes an object root, machine-visible action enum, and exact recurrence variants", () => {
    const schema = manageAgentSchedule.inputSchema as z.ZodType;
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;

    expect(jsonSchema).toMatchObject({ additionalProperties: false, type: "object" });
    expect(jsonSchema).not.toHaveProperty("anyOf");
    expect(jsonSchema).not.toHaveProperty("oneOf");
    expect(properties.action.enum).toEqual(["create", "update", "pause", "resume", "run_now", "delete"]);
    expect(schema.safeParse({ ...validDailyCreatePayload, recurrence: { kind: "once" } }).success).toBe(true);
    expect(schema.safeParse({
      ...validDailyCreatePayload,
      recurrence: { daysOfWeek: [1, 5], interval: 2, kind: "weekly" },
    }).success).toBe(true);
    expect(schema.safeParse({ ...validDailyCreatePayload, recurrence: { kind: "daily" } }).success).toBe(false);
    expect(schema.safeParse({
      ...validDailyCreatePayload,
      recurrence: { daysOfWeek: [1], interval: 1, kind: "daily" },
    }).success).toBe(false);
    expect(schema.safeParse({ ...validDailyCreatePayload, recurrence: { interval: 1, kind: "once" } }).success).toBe(false);
    expect(schema.safeParse({ ...validDailyCreatePayload, recurrence: { interval: 1, kind: "monthly" } }).success).toBe(false);
  });

  it("routes a valid daily schedule payload into the repository", async () => {
    await expect(manageAgentSchedule.execute(validDailyCreatePayload, context)).resolves.toEqual({
      id: "schedule-1",
    });

    expect(createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      expect.objectContaining({
        firstRunAt: new Date("2026-07-15T20:33:00.000Z"),
        operationKey: "call-1",
        recurrence: { interval: 1, kind: "daily" },
        scope: "personal",
        timezone: "Europe/Moscow",
      }),
    );
  });

  it("returns an actionable error when the model sends an empty payload", async () => {
    await expect(manageAgentSchedule.execute({} as never, context)).rejects.toThrowError(
      /AGENT_SCHEDULE_INPUT_INVALID: Для manage_agent_schedule передайте action/,
    );
    expect(createSchedule).not.toHaveBeenCalled();
  });

  it("explains the exact recurrence shape when daily interval is missing", async () => {
    await expect(manageAgentSchedule.execute({
      ...validDailyCreatePayload,
      recurrence: { kind: "daily" },
    } as never, context)).rejects.toThrowError(
      /AGENT_SCHEDULE_INPUT_INVALID: Для daily recurrence передайте recurrence: \{"kind":"daily","interval":1\}/,
    );
    expect(createSchedule).not.toHaveBeenCalled();
  });

  it("never requests approval for schedule mutations", () => {
    expect(manageAgentSchedule.approval).toBeUndefined();
  });

  it("rejects unknown root and recurrence fields fail-closed", async () => {
    await expect(manageAgentSchedule.execute({ ...validDailyCreatePayload, firstRun: "tomorrow" } as never, context)).rejects.toThrowError(
      /AGENT_SCHEDULE_INPUT_INVALID.*firstRun/u,
    );
    await expect(manageAgentSchedule.execute({
      ...validDailyCreatePayload,
      recurrence: { interval: 1, kind: "daily", unit: "days" },
    } as never, context)).rejects.toThrowError(/AGENT_SCHEDULE_INPUT_INVALID.*unit/u);
  });

  it("ignores only known create-only siblings materialized by MiniMax on update", async () => {
    await expect(manageAgentSchedule.execute({
      action: "update",
      firstRunAt: "2026-08-02T10:00:00+03:00",
      id: scheduleId,
      nextRunAt: "2026-08-03T10:00:00+03:00",
      scope: "family",
      timezone: "Europe/Moscow",
    }, context)).resolves.toEqual({ id: scheduleId });

    expect(updateSchedule).toHaveBeenCalledWith(
      expect.anything(),
      scheduleId,
      {
        nextRunAt: new Date("2026-08-03T07:00:00.000Z"),
        operationKey: "call-1",
        recurrence: undefined,
        scenarioPrompt: undefined,
        title: undefined,
        userRequest: undefined,
      },
    );
  });

  it.each(["delete", "pause", "resume", "run_now"] as const)(
    "keeps action=%s id-only even for known shared sibling fields",
    async (action) => {
      await expect(manageAgentSchedule.execute({ action, id: scheduleId, timezone: "Europe/Moscow" }, context)).rejects.toThrowError(
        new RegExp(`AGENT_SCHEDULE_INPUT_INVALID: action=${action} содержит неизвестные поля: timezone`),
      );
    },
  );

  it("documents exact create, update, and id-only payloads without a delete/recreate workaround", () => {
    expect(manageAgentSchedule.description).toContain('Create payload: {"action":"create"');
    expect(manageAgentSchedule.description).toContain(
      "Update передаёт id и только реально изменяемые поля",
    );
    expect(manageAgentSchedule.description).toContain(
      "Pause, resume, run_now и delete передают только action и id",
    );
    expect(manageAgentSchedule.description).toContain("Не удаляй и не пересоздавай расписание для изменения");
  });
});
