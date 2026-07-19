/**
 * Agent schedule dispatch orchestration.
 *
 * Exports:
 * - `createAgentScheduleDispatcher`: injectable deterministic lease-to-Eve handoff processor.
 * - `dispatchDueAgentSchedules`: production dispatcher used by the Eve minute schedule.
 */
import { telegramContinuationToken } from "eve/channels/telegram";
import type { ScheduleHandlerArgs } from "eve/schedules";

import telegram from "../../channels/telegram.js";
import {
  AGENT_SCHEDULE_DISPATCH_BATCH_SIZE,
  AGENT_SCHEDULE_DISPATCH_LEASE_MILLISECONDS,
} from "./agent-schedule-config.js";
import {
  type ClaimedAgentSchedule,
  agentScheduleDispatchRepository,
} from "./agent-schedule-dispatch-repository.js";
import { numericMessageThreadId } from "./agent-schedule-validation.js";
import { sessionRepository, type PreparedSession } from "../sessions/session-repository.js";

type ReceiveFn = ScheduleHandlerArgs["receive"];

interface AgentScheduleDispatcherRepository {
  claimDue(options: {
    leaseMilliseconds: number;
    limit: number;
    now: Date;
  }): Promise<ClaimedAgentSchedule[]>;
  failClaim(job: ClaimedAgentSchedule, errorCode: string): Promise<void>;
  markDispatchStarted(job: ClaimedAgentSchedule): Promise<void>;
  markRunning(
    job: ClaimedAgentSchedule,
    input: { applicationSessionId: string; eveSessionId: string },
  ): Promise<void>;
}

interface AgentScheduleDispatcherDependencies {
  prepareSession(job: ClaimedAgentSchedule, baseContinuationToken: string, now: Date): Promise<PreparedSession>;
  receive: ReceiveFn;
  repository: AgentScheduleDispatcherRepository;
}

function memoryScopes(job: ClaimedAgentSchedule): Array<"family" | "personal"> {
  return job.scope === "personal" ? ["personal", "family"] : ["family"];
}

function scheduledConversationId(job: ClaimedAgentSchedule): string {
  return `schedule:${job.runId}`;
}

function baseContinuationToken(job: ClaimedAgentSchedule): string {
  return telegramContinuationToken({
    chatId: job.telegramChatId,
    conversationId: scheduledConversationId(job),
    ...(job.messageThreadId === null
      ? {}
      : { messageThreadId: numericMessageThreadId(job.messageThreadId) }),
  });
}

function scheduledRunPrompt(job: ClaimedAgentSchedule): string {
  // The model still receives a normal user message, but delivery handlers suppress progress.
  return [
    "Выполни запланированный агентный сценарий для Telegram.",
    "Не пиши промежуточные статусы и не описывай процесс. Итоговый ответ должен быть готовым сообщением для пользователя.",
    "Если обязательной авторизации или данных не хватает, задай один понятный вопрос или сообщи конкретную ошибку.",
    "<scheduled_agent_run>",
    `schedule_id: ${job.id}`,
    `run_id: ${job.runId}`,
    `title: ${job.title}`,
    `scheduled_for: ${job.nextRunAt}`,
    `timezone: ${job.timezone}`,
    "original_user_request:",
    job.userRequest,
    "scenario:",
    job.scenarioPrompt,
    "</scheduled_agent_run>",
  ].join("\n");
}

function scheduledAuth(job: ClaimedAgentSchedule, prepared: PreparedSession) {
  return {
    attributes: {
      applicationSessionId: prepared.id,
      familyId: job.familyId,
      memoryScopes: memoryScopes(job),
      role: job.role,
      sandboxSessionId: prepared.sandboxSessionId,
      scheduleId: job.id,
      scheduleScheduledFor: job.nextRunAt,
      scheduleTitle: job.title,
      scheduledRunId: job.runId,
      telegramChatId: job.telegramChatId,
      telegramChatType: job.telegramChatType,
      ...(job.messageThreadId === null ? {} : { telegramMessageThreadId: job.messageThreadId }),
      telegramUserId: job.telegramUserId,
      ...(job.groupId === null ? {} : { groupId: job.groupId, groupType: "family_private" }),
    },
    authenticator: "telegram" as const,
    principalId: job.authorUserId,
    principalType: "user" as const,
  };
}

async function dispatchOne(
  dependencies: AgentScheduleDispatcherDependencies,
  job: ClaimedAgentSchedule,
  now: Date,
): Promise<void> {
  await dependencies.repository.markDispatchStarted(job);
  const baseToken = baseContinuationToken(job);
  const prepared = await dependencies.prepareSession(job, baseToken, now);
  try {
    const session = await dependencies.receive(telegram, {
      auth: scheduledAuth(job, prepared),
      message: scheduledRunPrompt(job),
      target: {
        chatId: job.telegramChatId,
        conversationId: scheduledConversationId(job),
        ...(job.messageThreadId === null
          ? {}
          : { messageThreadId: numericMessageThreadId(job.messageThreadId) }),
      },
    });
    await dependencies.repository.markRunning(job, {
      applicationSessionId: prepared.id,
      eveSessionId: session.id,
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_SCHEDULE_HANDOFF_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
      scheduleId: job.id,
      runId: job.runId,
    }));
    await dependencies.repository.failClaim(job, "AGENT_SCHEDULE_HANDOFF_FAILED");
  }
}

export function createAgentScheduleDispatcher(dependencies: AgentScheduleDispatcherDependencies) {
  return async function dispatchAgentSchedules(now = new Date()): Promise<number> {
    const jobs = await dependencies.repository.claimDue({
      leaseMilliseconds: AGENT_SCHEDULE_DISPATCH_LEASE_MILLISECONDS,
      limit: AGENT_SCHEDULE_DISPATCH_BATCH_SIZE,
      now,
    });

    // Sequential handoff bounds model-start pressure and keeps lease diagnostics ordered.
    for (const job of jobs) {
      await dispatchOne(dependencies, job, now);
    }
    return jobs.length;
  };
}

export function dispatchDueAgentSchedules(receive: ReceiveFn, now = new Date()): Promise<number> {
  return createAgentScheduleDispatcher({
    prepareSession: (job, continuationToken, currentTime) => sessionRepository.prepareTurn({
      baseContinuationToken: continuationToken,
      familyId: job.familyId,
      groupId: job.groupId,
      now: currentTime,
      scope: job.scope,
      userId: job.scope === "personal" ? job.authorUserId : null,
    }),
    receive,
    repository: agentScheduleDispatchRepository,
  })();
}
