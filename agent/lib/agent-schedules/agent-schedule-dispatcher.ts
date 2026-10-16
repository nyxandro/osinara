/**
 * Agent schedule dispatch orchestration.
 *
 * Exports:
 * - `createAgentScheduleDispatcher`: injectable deterministic lease-to-turn handoff processor.
 * - `dispatchDueAgentSchedules`: production dispatcher used by the minute schedule.
 * - `ScheduledChatStart`: starts the run's turn in its own session of the target chat.
 *
 * A conversation occurrence is not started here: it waits in its chat's queue and runs as a turn of
 * that chat's own conversation once the queue is free.
 */
import type { SessionAuthContext } from "../../runtime/context.js";
import { telegramContinuationToken } from "../../runtime/telegram/api.js";
import type { TelegramReceiveTarget } from "../../runtime/telegram/telegram-channel.js";

import { AGENT_SCHEDULE_DISPATCH_BATCH_SIZE, AGENT_SCHEDULE_DISPATCH_LEASE_MILLISECONDS } from "./agent-schedule-config.js";
import { type ClaimedAgentSchedule, agentScheduleDispatchRepository } from "./agent-schedule-dispatch-repository.js";
import { scheduledGroupHistorySnapshotRepository } from "./scheduled-group-history-snapshot-repository.js";
import { numericMessageThreadId } from "./agent-schedule-validation.js";
import { sessionRepository, type PreparedSession } from "../sessions/session-repository.js";
import { isDatabaseUnavailable, recoverDatabaseBookkeeping } from "../database-recovery.js";
import { EMPTY_DELIVERY_MARKER } from "../../runtime/turn/step-history.js";
import { localScheduledTime } from "../scheduling/local-time.js";
import { conversationWakeupRepository } from "../conversation-wakeups/conversation-wakeup-repository.js";

interface AgentScheduleDispatcherRepository {
  claimDue(options: { leaseMilliseconds: number; limit: number; now: Date }): Promise<ClaimedAgentSchedule[]>;
  failClaim(job: ClaimedAgentSchedule, errorCode: string): Promise<void>;
  markDispatchStarted(job: ClaimedAgentSchedule, input: { applicationSessionId: string }): Promise<boolean>;
  markRunning(job: ClaimedAgentSchedule, input: { applicationSessionId: string; agentSessionId: string }): Promise<void>;
}

interface AgentScheduleDispatcherDependencies {
  discardSession(applicationSessionId: string): Promise<void>;
  /** Hands a conversation occurrence to its chat queue instead of starting a session here. */
  enqueueConversation(job: ClaimedAgentSchedule): Promise<"parked" | "queued">;
  prepareHistory(job: ClaimedAgentSchedule): Promise<unknown>;
  prepareSession(job: ClaimedAgentSchedule, baseContinuationToken: string, now: Date): Promise<PreparedSession>;
  repository: AgentScheduleDispatcherRepository;
  startInChat: ScheduledChatStart;
}

/** Starts the run's turn in its chat; the turn then runs in the background. */
export type ScheduledChatStart = (
  target: TelegramReceiveTarget,
  message: string,
  options: { readonly auth: SessionAuthContext },
) => Promise<{ readonly sessionId: string }>;

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
    "Carry out the scheduled agent scenario for Telegram.",
    "Do not write intermediate statuses and do not describe the process. The final answer must be a ready message for the user, in Russian.",
    `If the scenario says to send nothing when there is nothing to report, and this is exactly such a case, end the run with exactly the line ${EMPTY_DELIVERY_MARKER} and no other text: this is a successful run without a message, not an error. This is allowed only if you sent nothing in this run, including as a file. Any phrase like "новостей нет" goes to the chat as a message.`,
    "If required authorization or data is missing, ask one clear question or report the specific error.",
    "A failure of one dependency does not cancel independent parts of the task. In the result, clearly separate verified facts from unavailable sections; do not declare an incomplete task fully completed.",
    "<scheduled_agent_run>",
    `schedule_id: ${job.id}`,
    `run_id: ${job.runId}`,
    `title: ${job.title}`,
    `scheduled_for: ${job.nextRunAt}`,
    `scheduled_for_local: ${localScheduledTime(job.nextRunAt, job.timezone)}`,
    `timezone: ${job.timezone}`,
    `completed_runs: ${job.completedRuns}`,
    `execution_number: ${job.completedRuns + 1}`,
    `max_runs: ${job.maxRuns === null ? "unlimited" : job.maxRuns}`,
    "execution_number is the number of this run; a silent run without a message also counts as a run. Use it for numbering; the scheduler keeps the counter. With max_runs it ends the schedule itself after the last run.",
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
  if (job.executionContext === "conversation") {
    const outcome = await dependencies.enqueueConversation(job);
    console.info(JSON.stringify({ code: "AGENT_SCHEDULE_CONVERSATION_ENQUEUED", outcome, runId: job.runId, scheduleId: job.id }));
    return;
  }
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
    // The run gets its own session at its own address in the chat, as a separate conversation.
    const started = await dependencies.startInChat({
      chatId: job.telegramChatId,
      conversationId: scheduledConversationId(job),
      ...(job.messageThreadId === null ? {} : { messageThreadId: numericMessageThreadId(job.messageThreadId) }),
    }, scheduledRunPrompt(job), { auth: scheduledAuth(job, prepared) });
    await recoverDatabaseBookkeeping(() => dependencies.repository.markRunning(job, {
      applicationSessionId: prepared.id,
      agentSessionId: started.sessionId,
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

export function dispatchDueAgentSchedules(startInChat: ScheduledChatStart, now = new Date()): Promise<number> {
  return createAgentScheduleDispatcher({
    discardSession: (applicationSessionId) => sessionRepository.retireUnstartedScheduledSession(applicationSessionId),
    enqueueConversation: (job) => conversationWakeupRepository.enqueue(job),
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
    startInChat,
  })();
}
