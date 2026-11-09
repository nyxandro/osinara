/**
 * Scheduled external tool authorization wrapper tests.
 *
 * Constructs covered:
 * - Every wrapped execution revalidates the exact active run and destination.
 * - Authorization runs before the underlying workspace/network/tool operation.
 * - A scenario of a private chat checks its run the same way before each message it sends, and a
 *   delivered send's advice to end the turn becomes the scenario's (#480).
 */
import { defineTool } from "../../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { authorizeAgentScheduleExecution } = vi.hoisted(() => ({
  authorizeAgentScheduleExecution: vi.fn(),
}));
vi.mock("../agent-schedules/agent-schedule-delivery-authorization.js", () => ({
  authorizeAgentScheduleExecution,
}));

import { scheduledExternalTool, scheduledSendTool } from "./scheduled-external-tool.js";

function context() {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            applicationSessionId: "app-session-1",
            familyId: "family-1",
            groupId: "group-1",
            groupType: "external",
            memoryScopes: ["group"],
            scheduleScheduledFor: "2026-08-17T06:00:00.000Z",
            scheduleTitle: "Отчёт",
            scheduledRunId: "run-1",
            telegramChatId: "-1001",
          },
          authenticator: "telegram",
          principalId: "owner-1",
          principalType: "user",
        },
      },
      id: "agent-session-1",
    },
  } as never;
}

describe("scheduled external tool", () => {
  beforeEach(() => authorizeAgentScheduleExecution.mockReset());

  it("authorizes before executing the underlying tool", async () => {
    authorizeAgentScheduleExecution.mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool = scheduledExternalTool(defineTool({
      description: "test",
      execute,
      inputSchema: z.object({}).strict(),
    }) as never);

    await expect(tool.execute({}, context())).resolves.toEqual({ ok: true });
    expect(authorizeAgentScheduleExecution).toHaveBeenCalledWith({
      applicationSessionId: "app-session-1",
      familyId: "family-1",
      groupId: "group-1",
      messageThreadId: null,
      ownerUserId: null,
      runId: "run-1",
      scope: "group",
      telegramChatId: "-1001",
    });
    expect(authorizeAgentScheduleExecution.mock.invocationCallOrder[0])
      .toBeLessThan(execute.mock.invocationCallOrder[0]!);
  });

  it("checks a private scenario's run before its send and keeps the scenario going after it (#480)", async () => {
    authorizeAgentScheduleExecution.mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ delivered: true, nextStep: "Это твой ответ: заверши ход.", telegramMessageId: "91" });
    const tool = scheduledSendTool(defineTool({ description: "test", execute, inputSchema: z.object({}).strict() }) as never);
    const privateScenario = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1", familyId: "family-1", memoryScopes: ["personal"],
              scheduleScheduledFor: "2026-11-09T04:30:00.000Z", scheduleTitle: "Утренние задачи", scheduledRunId: "run-1",
              telegramChatId: "101",
            },
            authenticator: "telegram", principalId: "user-1", principalType: "user",
          },
        },
        id: "agent-session-1",
      },
    } as never;

    const result = await tool.execute({}, privateScenario) as { nextStep: string; telegramMessageId: string };

    expect(authorizeAgentScheduleExecution).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: "user-1", runId: "run-1", scope: "personal" }));
    expect(result.telegramMessageId).toBe("91");
    expect(result.nextStep).toMatch(/Выполни оставшиеся шаги сценария/u);
  });

  it("sends nothing outside a verified scenario run (#480)", async () => {
    const execute = vi.fn();
    const tool = scheduledSendTool(defineTool({ description: "test", execute, inputSchema: z.object({}).strict() }) as never);
    const liveTurn = {
      session: {
        auth: { current: { attributes: { familyId: "family-1", telegramChatId: "101" }, authenticator: "telegram", principalId: "user-1", principalType: "user" } },
        id: "agent-session-1",
      },
    } as never;

    await expect(Promise.resolve().then(() => tool.execute({}, liveTurn))).rejects.toThrow(/AGENT_SCHEDULE_EXECUTION_AUTHORIZATION_REVOKED/u);
    expect(authorizeAgentScheduleExecution).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
