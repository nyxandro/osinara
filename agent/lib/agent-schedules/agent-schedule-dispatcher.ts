/**
 * Agent schedule dispatch orchestration.
 *
 * Exports:
 * - `createAgentScheduleDispatcher`: injectable deterministic lease-to-Eve handoff processor.
 * - `dispatchDueAgentSchedules`: production dispatcher used by the Eve minute schedule.
 */
import { telegramContinuationToken } from "eve/channels/telegram";
import type { ScheduleToFn } from "eve/schedules";

import telegram from "../../channels/telegram.js";
import { AGENT_SCHEDULE_DISPATCH_BATCH_SIZE, AGENT_SCHEDULE_DISPATCH_LEASE_MILLISECONDS } from "./agent-schedule-config.js";
import { type ClaimedAgentSchedule, agentScheduleDispatchRepository } from "./agent-schedule-dispatch-repository.js";
import { scheduledGroupHistorySnapshotRepository } from "./scheduled-group-history-snapshot-repository.js";
import { numericMessageThreadId } from "./agent-schedule-validation.js";
import { sessionRepository, type PreparedSession } from "../sessions/session-repository.js";
import { isDatabaseUnavailable, recoverDatabaseBookkeeping } from "../database-recovery.js";
import { localScheduledTime } from "../scheduling/local-time.js";

interface AgentScheduleDispatcherRepository {
  claimDue(options: { leaseMilliseconds: number; limit: number; now: Date }): Promise<ClaimedAgentSchedule[]>;
  failClaim(job: ClaimedAgentSchedule, errorCode: string): Promise<void>;
  markDispatchStarted(job: ClaimedAgentSchedule, input: { applicationSessionId: string }): Promise<boolean>;
  markRunning(job: ClaimedAgentSchedule, input: { applicationSessionId: string; eveSessionId: string }): Promise<void>;
}

interface AgentScheduleDispatcherDependencies {
  discardSession(applicationSessionId: string): Promise<void>;
  prepareHistory(job: ClaimedAgentSchedule): Promise<unknown>;
  prepareSession(job: ClaimedAgentSchedule, baseContinuationToken: string, now: Date): Promise<PreparedSession>;
  repository: AgentScheduleDispatcherRepository;
  to: ScheduleToFn;
}

function memoryScopes(job: ClaimedAgentSchedule): Array<"family" | "group" | "personal"> {
  if (job.scope === "personal") return ["personal", "family"];
  return [job.scope];
}

function scheduledConversationId(job: ClaimedAgentSchedule): string {
  return `schedule:${job.runId}`;
}

function baseContinuationToken(job: ClaimedAgentSchedule): string {
  return telegramContinuationToken({
    chatId: job.telegramChatId,
    conversationId: scheduledConversationId(job),
    ...(job.messageThreadId === null ? {} : { messageThreadId: numericMessageThreadId(job.messageThreadId) }),
  });
}

function scheduledRunPrompt(job: ClaimedAgentSchedule): string {
  // The model still receives a normal user message, but delivery handlers suppress progress.
  return [
    "Выполни запланированный агентный сценарий для Telegram.",
    "Не пиши промежуточные статусы и не описывай процесс. Итоговый ответ должен быть готовым сообщением для пользователя.",
    "Если обязательной авторизации или данных не хватает, задай один понятный вопрос или сообщи конкретную ошибку.",
    "Сбой одной зависимости не отменяет независимые части задания. В результате явно отдели проверенные сведения от недоступных разделов; не объявляй неполную задачу полностью выполненной.",
    "<scheduled_agent_run>",
    `schedule_id: ${job.id}`,
    `run_id: ${job.runId}`,
    `title: ${job.title}`,
    `scheduled_for: ${job.nextRunAt}`,
    `scheduled_for_local: ${localScheduledTime(job.nextRunAt, job.timezone)}`,
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
      role: job.scope === "group" ? "external" : job.role,
      sandboxSessionId: prepared.sandboxSessionId,
      scheduleId: job.id,
      scheduleScheduledFor: job.nextRunAt,
      scheduleTitle: job.title,
      scheduledRunId: job.runId,
      telegramChatId: job.telegramChatId,
      telegramChatType: job.telegramChatType,
      telegramActorId: job.telegramUserId,
      telegramActorKind: "telegram_user",
      ...(job.messageThreadId === null ? {} : { telegramMessageThreadId: job.messageThreadId }),
      ...(job.forumTopicId === null ? {} : { telegramForumTopicId: job.forumTopicId }),
      telegramUserId: job.telegramUserId,
      ...(job.groupId === null
        ? {}
        : {
            groupId: job.groupId,
            groupType: job.scope === "group" ? "external" : "family_private",
          }),
      ...(job.scope === "group"
        ? {
            scheduledGroupHistory: job.historyWindowDays === null ? "disabled" : "enabled",
            skillAllowlist: [],
            toolAllowlist: job.capabilityAllowlist,
          }
        : {}),
    },
    authenticator: "telegram" as const,
    principalId: job.authorUserId,
    principalType: "user" as const,
  };
}

async function dispatchOne(dependencies: AgentScheduleDispatcherDependencies, job: ClaimedAgentSchedule, now: Date): Promise<void> {
  if (job.scope === "group" && job.historyWindowDays !== null) {
    try {
      await dependencies.prepareHistory(job);
    } catch (error) {
      console.error(
        JSON.stringify({
          code: "AGENT_SCHEDULE_HISTORY_PREPARATION_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          runId: job.runId,
          scheduleId: job.id,
        }),
      );
      await dependencies.repository.failClaim(job, "AGENT_SCHEDULE_HISTORY_PREPARATION_FAILED");
      return;
    }
  }
  const baseToken = baseContinuationToken(job);
  const prepared = await dependencies.prepareSession(job, baseToken, now);
  let dispatchStarted: boolean;
  try {
    dispatchStarted = await dependencies.repository.markDispatchStarted(job, {
      applicationSessionId: prepared.id,
    });
  } catch (error) {
    if (isDatabaseUnavailable(error)) throw error;
    console.error(
      JSON.stringify({
        code: "AGENT_SCHEDULE_DISPATCH_MARKER_FAILED",
        errorName: error instanceof Error ? error.name : "UnknownError",
        runId: job.runId,
        scheduleId: job.id,
      }),
    );
    await dependencies.discardSession(prepared.id);
    throw error;
  }
  if (dispatchStarted === false) {
    await dependencies.discardSession(prepared.id);
    return;
  }
  try {
    // `to(...).send(...)` keeps channel selection and receive execution inside Eve's native source.
    const session = await dependencies
      .to(telegram, {
        chatId: job.telegramChatId,
        conversationId: scheduledConversationId(job),
        ...(job.messageThreadId === null ? {} : { messageThreadId: numericMessageThreadId(job.messageThreadId) }),
      })
      .send(scheduledRunPrompt(job), { auth: scheduledAuth(job, prepared) });
    await recoverDatabaseBookkeeping(() => dependencies.repository.markRunning(job, {
      applicationSessionId: prepared.id,
      eveSessionId: session.id,
    }));
  } catch (error) {
    if (isDatabaseUnavailable(error)) throw error;
    console.error(
      JSON.stringify({
        code: "AGENT_SCHEDULE_HANDOFF_FAILED",
        errorName: error instanceof Error ? error.name : "UnknownError",
        scheduleId: job.id,
        runId: job.runId,
      }),
    );
    await dependencies.repository.failClaim(job, "AGENT_SCHEDULE_HANDOFF_FAILED");
    await dependencies.discardSession(prepared.id);
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
      try {
        await dispatchOne(dependencies, job, now);
      } catch (error) {
        // One claimed job owns its lease and cleanup lifecycle; its failure must not strand the
        // remaining already-claimed jobs in this batch until their leases expire.
        console.error(
          JSON.stringify({
            code: "AGENT_SCHEDULE_DISPATCH_FAILED",
            errorName: error instanceof Error ? error.name : "UnknownError",
            runId: job.runId,
            scheduleId: job.id,
          }),
        );
      }
    }
    return jobs.length;
  };
}

export function dispatchDueAgentSchedules(to: ScheduleToFn, now = new Date()): Promise<number> {
  return createAgentScheduleDispatcher({
    discardSession: (applicationSessionId) => sessionRepository.retireUnstartedScheduledSession(applicationSessionId),
    prepareHistory: (job) =>
      scheduledGroupHistorySnapshotRepository.prepare({
        groupId: job.groupId!,
        runId: job.runId,
        scheduleId: job.id,
      }),
    prepareSession: (job, continuationToken, currentTime) =>
      sessionRepository.prepareTurn({
        baseContinuationToken: continuationToken,
        familyId: job.familyId,
        groupId: job.groupId,
        kind: "scheduled",
        now: currentTime,
        scope: job.scope,
        telegramForumTopicId: job.forumTopicId === null ? null : numericMessageThreadId(job.forumTopicId)!,
        userId: job.scope === "personal" ? job.authorUserId : null,
      }),
    repository: agentScheduleDispatchRepository,
    to,
  })();
}
