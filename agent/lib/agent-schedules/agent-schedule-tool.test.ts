/**
 * Agent schedule tool contract tests.
 *
 * Constructs covered:
 * - `manage_agent_schedule.create`: routes a valid model payload into the repository boundary.
 * - Invalid model payloads return stable, actionable application errors from tool execution.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSchedule } = vi.hoisted(() => ({ createSchedule: vi.fn() }));

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
    delete: vi.fn(),
    runNow: vi.fn(),
    update: vi.fn(),
  },
}));

import manageAgentSchedule from "../../tools/manage_agent_schedule.js";

const context = { callId: "call-1" } as ToolContext;
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
    createSchedule.mockResolvedValue({ id: "schedule-1" });
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
    await expect(manageAgentSchedule.execute({}, context)).rejects.toThrowError(
      /AGENT_SCHEDULE_INPUT_INVALID: Для manage_agent_schedule передайте action/,
    );
    expect(createSchedule).not.toHaveBeenCalled();
  });

  it("explains the exact recurrence shape when daily interval is missing", async () => {
    await expect(manageAgentSchedule.execute({
      ...validDailyCreatePayload,
      recurrence: { kind: "daily" },
    }, context)).rejects.toThrowError(
      /AGENT_SCHEDULE_INPUT_INVALID: Для daily recurrence передайте recurrence: \{"kind":"daily","interval":1\}/,
    );
    expect(createSchedule).not.toHaveBeenCalled();
  });
});
