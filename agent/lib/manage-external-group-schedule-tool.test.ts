/**
 * Owner-only external-group schedule tool tests.
 *
 * Constructs covered:
 * - Read-only status does not require approval and lists only owner-managed external schedules.
 * - Create needs no approval and forwards an explicit destination, capability subset, and history window.
 * - Invalid schema and action semantics become model-readable denials before execution.
 * - Mutations use opaque schedule IDs and never accept model-selected family or group IDs.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  owner: vi.fn(),
}));

vi.mock("./agent-schedules/external-agent-schedule-repository.js", () => ({
  externalAgentScheduleRepository: {
    create: dependencies.create,
    list: dependencies.list,
  },
}));
vi.mock("./family-context.js", () => ({
  requirePrivateTelegramOwner: dependencies.owner,
}));

import manageExternalGroupSchedule from "./tools/manage_external_group_schedule.js";

function approvalFor(toolInput: unknown): unknown {
  return (manageExternalGroupSchedule.approval as (context: never) => unknown)(
    { toolInput } as never,
  );
}

const context = { callId: "call-1" } as ToolContext;

describe("manage_external_group_schedule", () => {
  beforeEach(() => {
    dependencies.create.mockReset();
    dependencies.list.mockReset();
    dependencies.owner.mockReset();
    dependencies.owner.mockReturnValue({ familyId: "family-1", userId: "owner-1" });
  });

  it("lists schedules without approval from the verified owner scope", async () => {
    dependencies.list.mockResolvedValue({ items: [], total: 0 });
    const input = { action: "status" } as const;

    expect(await approvalFor(input))
      .toBe("not-applicable");
    await expect(manageExternalGroupSchedule.execute(input, context)).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(dependencies.list).toHaveBeenCalledWith({
      familyId: "family-1",
      requestedBy: "owner-1",
      telegramChatId: null,
    });
  });

  it("creates a weekly group automation with an explicit retained-history window", async () => {
    const input = {
      action: "create",
      capabilityAllowlist: ["send_workspace_file"],
      firstRunAt: "2026-08-17T09:00:00+03:00",
      historyWindowDays: 7,
      recurrence: { daysOfWeek: [1], interval: 1, kind: "weekly" },
      scenarioPrompt: "Прочитай весь снимок истории, подготовь HTML-выжимку и отправь файл в чат.",
      telegramChatId: "-1001234567890",
      timezone: "Europe/Moscow",
      title: "Недельная HTML-выжимка",
      userRequest: "Каждый понедельник присылай HTML-выжимку обсуждения за неделю",
    } as const;
    dependencies.create.mockResolvedValue({ id: "schedule-1", scope: "group" });

    expect(await approvalFor(input))
      .toBe("not-applicable");
    await manageExternalGroupSchedule.execute({
      ...input,
      capabilityAllowlist: [...input.capabilityAllowlist],
      recurrence: { ...input.recurrence, daysOfWeek: [...input.recurrence.daysOfWeek] },
    }, context);

    expect(dependencies.create).toHaveBeenCalledWith(
      { familyId: "family-1", requestedBy: "owner-1" },
      expect.objectContaining({
        capabilityAllowlist: ["send_workspace_file"],
        firstRunAt: new Date("2026-08-17T06:00:00.000Z"),
        historyWindowDays: 7,
        operationKey: "call-1",
        telegramChatId: "-1001234567890",
        timezone: "Europe/Moscow",
      }),
    );
  });

  it("returns a structured denial for schema-invalid approval input", () => {
    expect(approvalFor(undefined)).toEqual({
      reason:
        "AGENT_EXTERNAL_SCHEDULE_INPUT_INVALID: Входные данные не соответствуют схеме manage_external_group_schedule. Проверьте обязательные поля и их типы",
      type: "denied",
    });
  });

  it.each(["minutely", "hourly", "monthly", "yearly"])("creates %s external automations", async (kind) => {
    const input = {
      action: "create", capabilityAllowlist: [], firstRunAt: "2026-09-12T18:00:00+03:00",
      recurrence: { kind, interval: 1 }, scenarioPrompt: "Проверь ресурс", telegramChatId: "-1001234567890",
      timezone: "Europe/Moscow", title: "Проверка", userRequest: "Проверяй по расписанию",
    };
    expect(await approvalFor(input)).toBe("not-applicable");
    await manageExternalGroupSchedule.execute(input as never, context);
    expect(dependencies.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ recurrence: input.recurrence }));
    await expect(manageExternalGroupSchedule.execute({ ...input, recurrence: { kind, interval: 0 } } as never, context))
      .rejects.toMatchObject({ code: "AGENT_EXTERNAL_SCHEDULE_INPUT_INVALID" });
  });

  it("returns a structured denial for semantically incomplete approval input", () => {
    expect(approvalFor({ action: "create" })).toEqual({
      reason: "AGENT_EXTERNAL_SCHEDULE_INPUT_INVALID: Для action=create обязательно поле recurrence",
      type: "denied",
    });
  });

  it.each([
    [
      "schema-invalid",
      {} as never,
      "AGENT_EXTERNAL_SCHEDULE_INPUT_INVALID: Входные данные не соответствуют схеме manage_external_group_schedule. Проверьте обязательные поля и их типы",
    ],
    [
      "semantic-invalid",
      { action: "create" } as never,
      "AGENT_EXTERNAL_SCHEDULE_INPUT_INVALID: Для action=create обязательно поле recurrence",
    ],
  ])("rejects %s execution before authorization or repository access", async (_case, input, message) => {
    await expect(manageExternalGroupSchedule.execute(input, context)).rejects.toMatchObject({
      code: "AGENT_EXTERNAL_SCHEDULE_INPUT_INVALID",
      message,
      name: "AppError",
    });
    expect(dependencies.owner).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.list).not.toHaveBeenCalled();
  });

  it("publishes no model-selectable familyId, groupId, or Telegram chat type", () => {
    const schema = JSON.stringify(manageExternalGroupSchedule.inputSchema);

    expect(schema).not.toContain("familyId");
    expect(schema).not.toContain("groupId");
    expect(schema).not.toContain("telegramChatType");
  });
});
