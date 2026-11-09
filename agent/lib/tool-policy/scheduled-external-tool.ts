/**
 * Execution-time owner authorization wrapper for scheduled external-group tools.
 *
 * Exports:
 * - `scheduledExternalTool`: denies every tool after run, owner, or destination revocation.
 * - `scheduledSendTool`: the same check before each message a scenario of a private chat or family
 *   group sends through a tool (#480), as its final text gets before delivery.
 */
import { defineTool, type ToolDefinition } from "../../runtime/tool.js";

import { authorizeAgentScheduleExecution } from "../agent-schedules/agent-schedule-delivery-authorization.js";
import { scheduledDeliveryMetadata } from "../agent-schedules/scheduled-session.js";
import { AppError } from "../app-error.js";

type AnyToolDefinition = ToolDefinition<any, any>;

export function scheduledExternalTool(definition: AnyToolDefinition): AnyToolDefinition {
  return defineTool({
    ...definition,
    async execute(input, ctx) {
      const scheduled = scheduledDeliveryMetadata(ctx);
      if (!scheduled || scheduled.scope !== "group") {
        throw new AppError(
          "AGENT_SCHEDULE_EXECUTION_AUTHORIZATION_REVOKED",
          "Не удалось подтвердить текущий запуск автоматизации внешней группы",
        );
      }
      await authorizeAgentScheduleExecution({
        applicationSessionId: scheduled.applicationSessionId,
        familyId: scheduled.familyId,
        groupId: scheduled.groupId,
        messageThreadId: scheduled.messageThreadId,
        ownerUserId: scheduled.ownerUserId,
        runId: scheduled.runId,
        scope: scheduled.scope,
        telegramChatId: scheduled.telegramChatId,
      });
      return await definition.execute(input, ctx);
    },
  });
}

export function scheduledSendTool(definition: AnyToolDefinition): AnyToolDefinition {
  return defineTool({
    ...definition,
    async execute(input, ctx) {
      const scheduled = scheduledDeliveryMetadata(ctx);
      if (!scheduled) {
        throw new AppError(
          "AGENT_SCHEDULE_EXECUTION_AUTHORIZATION_REVOKED",
          "Не удалось подтвердить текущий запуск сценария",
        );
      }
      await authorizeAgentScheduleExecution({
        applicationSessionId: scheduled.applicationSessionId,
        familyId: scheduled.familyId,
        groupId: scheduled.groupId,
        messageThreadId: scheduled.messageThreadId,
        ownerUserId: scheduled.ownerUserId,
        runId: scheduled.runId,
        scope: scheduled.scope,
        telegramChatId: scheduled.telegramChatId,
      });
      return await definition.execute(input, ctx);
    },
  });
}
