/**
 * Scheduled external tool authorization wrapper tests.
 *
 * Constructs covered:
 * - Every wrapped execution revalidates the exact active run and destination.
 * - Authorization runs before the underlying workspace/network/tool operation.
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

import { scheduledExternalTool } from "./scheduled-external-tool.js";

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
});
