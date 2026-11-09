/**
 * Execution-time owner authorization wrapper for scheduled external-group tools.
 *
 * Exports:
 * - `scheduledExternalTool`: denies every tool after run, owner, or destination revocation.
 * - `scheduledSendTool`: the same check before each message a scenario of a private chat or family
 *   group sends through a tool (#480), as its final text gets before delivery.
 *
 * A message a scenario sends is one step of its result, not the whole answer of a live turn: both
 * wrappers replace the delivered tool's own advice to end the turn with the scenario's (#480).
 */
import { defineTool, type ToolDefinition } from "../../runtime/tool.js";

import { authorizeAgentScheduleExecution } from "../agent-schedules/agent-schedule-delivery-authorization.js";
import { scheduledDeliveryMetadata } from "../agent-schedules/scheduled-session.js";
import { EMPTY_DELIVERY_MARKER } from "../../runtime/turn/step-history.js";

import { AppError } from "../app-error.js";

type AnyToolDefinition = ToolDefinition<any, any>;

const SCENARIO_NEXT_STEP = `Сообщение уже в чате как часть результата сценария. Нажатия, голоса в опросе и ответы придут не сюда, а в разговор этого чата. Выполни оставшиеся шаги сценария; если сказать больше нечего, заверши ход ровно строкой ${EMPTY_DELIVERY_MARKER} без другого текста.`;

/** A delivered send's result with the scenario's next step in place of the live turn's. */
function asScenarioStep(result: unknown): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  return record.delivered === true && typeof record.nextStep === "string" ? { ...record, nextStep: SCENARIO_NEXT_STEP } : result;
}

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
      return asScenarioStep(await definition.execute(input, ctx));
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
      return asScenarioStep(await definition.execute(input, ctx));
    },
  });
}
