/**
 * The application as one composition: the runtime, its channels, the HTTP server and the scheduler.
 *
 * Export:
 * - `startApplication`: starts everything on the given database connection settings and returns a
 *   handle that stops the server and the scheduler. `agent/main.ts` runs it as the process; the
 *   end-to-end test runs the same composition with a scripted model and test doubles of Telegram
 *   and the sandbox runner.
 *
 * Start, in order:
 * 1. The runner lock: one agent process per database; a second one stops here with
 *    `AGENT_RUNTIME_ALREADY_RUNNING`.
 * 2. The runtime: Osinara's agent, the model call, sandboxes, compaction, and an observer per
 *    channel (Telegram delivers, the memory review only records how its turn ended).
 * 3. Recovery: turns an earlier process left running continue from the journal, and what it left
 *    unreported (a card not shown, an end not reported) is reported.
 * 4. The HTTP server on the addresses Eve had: the Telegram webhook, the internal drain the
 *    ingress worker calls, the Google OAuth callback and the health check.
 * 5. The minute scheduler: reminders and approval timeouts, scheduled runs, memory review, the
 *    software update check, and recovery again for turns whose start a deploy held back.
 */
import { createTelegramIngress, telegramChannelHooks, telegramTurnEvents } from "./channels/telegram.js";
import { googleOAuthRoutes } from "./channels/google-oauth.js";
import { createMemoryReviewStart, MEMORY_REVIEW_CHANNEL_KIND, memoryReviewTurnEvents } from "./channels/memory-review.js";
import { TELEGRAM_INGRESS_LEASE_MS } from "./config.js";
import { AGENT_SCHEDULE_CONVERSATION_ADMISSION_MILLISECONDS } from "./lib/agent-schedules/agent-schedule-config.js";
import type { ScheduledChatStart } from "./lib/agent-schedules/agent-schedule-dispatcher.js";
import { createConversationWakeupProcessor } from "./lib/conversation-wakeups/conversation-wakeup-drain.js";
import { conversationWakeupRepository } from "./lib/conversation-wakeups/conversation-wakeup-repository.js";
import { createConversationWakeupTurn } from "./lib/conversation-wakeups/conversation-wakeup-turn-start.js";
import { database, openDedicatedConnection } from "./lib/database.js";
import { withRuntimeAdmission } from "./lib/runtime-maintenance.js";
import { createApprovalTimeoutResolver } from "./lib/telegram-hitl/approval-timeout.js";
import { finalizeTimedOutPrompt } from "./lib/telegram-hitl/approval-timeout-prompt.js";
import { approvalTimeoutRepository } from "./lib/telegram-hitl/approval-timeout-repository.js";
import type { RuntimeAgent } from "./runtime/agent-definition.js";
import { createTurnDispatcher } from "./runtime/dispatch.js";
import { respondInSession } from "./runtime/respond.js";
import { acquireRunnerLock } from "./runtime/runner-lock.js";
import { startScheduler } from "./runtime/scheduler.js";
import { startRuntimeServer } from "./runtime/server.js";
import { createTelegramChannel, telegramWebhookRoutes } from "./runtime/telegram/telegram-channel.js";
import { summarizeWithModel } from "./runtime/turn/compaction.js";
import { lifecycleTurnObserver } from "./runtime/turn/lifecycle-observer.js";
import { callStepModel } from "./runtime/turn/model-call.js";
import { routeTurnObservers } from "./runtime/turn/observer-routing.js";
import { createSessionSandboxes } from "./sandbox.js";
import { agentScheduleDispatchSchedule } from "./schedules/agent-schedule-dispatch.js";
import { memoryReviewDispatchSchedule } from "./schedules/memory-review-dispatch.js";
import { reminderDispatchSchedule } from "./schedules/reminder-dispatch.js";
import { softwareUpdateCheckSchedule } from "./schedules/software-update-check.js";

export const TELEGRAM_WEBHOOK_ROUTE = "/eve/v1/telegram";
export const TELEGRAM_DRAIN_ROUTE = "/eve/v1/telegram-drain";
// A waiting turn checks again this often when no turn of this process signals that its session moved on.
const TURN_WAIT_MILLISECONDS = 1_000;

export interface ApplicationOptions {
  readonly agent: RuntimeAgent;
  readonly botToken: string;
  readonly botUsername: string;
  readonly host: string;
  /**
   * Another process took the runner lock while this one had lost its connection: this process
   * must stop at once, or both would run the same turns.
   */
  readonly onRunnerLockTaken: () => void;
  readonly port: number;
  /**
   * This process's identity in the turn journal. One agent process runs at a time (the runner
   * lock): turns claimed under any other runner id are taken over at start and every minute.
   */
  readonly runnerId: string;
  readonly sandboxRunnerBaseUrl: string;
  readonly webhookSecretToken: string;
}

export interface RunningApplication {
  readonly port: number;
  /**
   * No new requests or schedule cycles; running work, background turns included, gets
   * `graceMilliseconds` and is never cancelled. The runner lock goes with the process: a turn still
   * running here after the grace is not taken over by a next process while this one runs it.
   */
  stop(graceMilliseconds: number): Promise<void>;
}

export async function startApplication(options: ApplicationOptions): Promise<RunningApplication> {
  const db = database();
  const runnerLock = await acquireRunnerLock(openDedicatedConnection, options.onRunnerLockTaken);
  const telegram = createTelegramChannel({
    botToken: options.botToken,
    botUsername: options.botUsername,
    database: db,
    events: telegramTurnEvents,
    ...telegramChannelHooks,
  });
  const dispatcher = createTurnDispatcher({
    // A turn that already exists may finish while a deploy drains, never once it is frozen.
    admit: (work) => withRuntimeAdmission("callback", work),
    runnerLock,
    runtime: {
      agent: options.agent,
      callModel: callStepModel,
      database: db,
      observer: routeTurnObservers({
        [MEMORY_REVIEW_CHANNEL_KIND]: lifecycleTurnObserver(memoryReviewTurnEvents),
        telegram: telegram.observer,
      }),
      runnerId: options.runnerId,
      sandbox: createSessionSandboxes({ baseUrl: options.sandboxRunnerBaseUrl, database: db }),
      summarize: summarizeWithModel,
    },
    waitMilliseconds: TURN_WAIT_MILLISECONDS,
  });

  const createWakeupTurn = createConversationWakeupTurn({
    admissionMilliseconds: AGENT_SCHEDULE_CONVERSATION_ADMISSION_MILLISECONDS,
    database: db,
    now: () => new Date(),
    repository: conversationWakeupRepository,
  });
  const ingress = createTelegramIngress({
    dispatch: telegram.dispatch,
    processConversationWakeup: ({ slots }) => createConversationWakeupProcessor({
      createTurn: createWakeupTurn,
      leaseMilliseconds: TELEGRAM_INGRESS_LEASE_MS,
      repository: conversationWakeupRepository,
      runTurn: dispatcher.run,
      slots,
    })(),
    runTurn: dispatcher.run,
  });
  const startInChat: ScheduledChatStart = async (target, message, { auth }) => {
    const started = await telegram.receive(target, message, { auth, kind: "scheduled" });
    dispatcher.start(started.turnId);
    return { sessionId: started.sessionId };
  };

  await dispatcher.recover();
  // A person's answer arrives through the server: it must not close a parked turn before its report.
  await dispatcher.reportsIdle();
  const server = await startRuntimeServer({
    host: options.host,
    port: options.port,
    routes: [
      ...telegramWebhookRoutes({
        drainRoute: TELEGRAM_DRAIN_ROUTE,
        onDrain: (context) => ingress.drain(context),
        onVerifiedUpdate: (context) => ingress(context),
        route: TELEGRAM_WEBHOOK_ROUTE,
        webhookSecretToken: options.webhookSecretToken,
      }),
      ...googleOAuthRoutes(),
    ],
  });
  const scheduler = startScheduler({
    schedules: [
      reminderDispatchSchedule({
        resolveTimedOutApprovals: createApprovalTimeoutResolver({
          finalizePrompt: finalizeTimedOutPrompt,
          repository: approvalTimeoutRepository,
          respond: (input) => respondInSession({ database: db, dispatcher }, input),
        }),
      }),
      agentScheduleDispatchSchedule(startInChat),
      memoryReviewDispatchSchedule(createMemoryReviewStart({ database: db, dispatcher })),
      softwareUpdateCheckSchedule(),
      { cron: "* * * * *", name: "turn-recovery", run: ({ waitUntil }) => waitUntil(dispatcher.recover()) },
    ],
  });
  console.info(JSON.stringify({ code: "AGENT_RUNTIME_STARTED", port: server.port }));
  return {
    port: server.port,
    async stop(graceMilliseconds) {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, graceMilliseconds); });
      await Promise.all([
        scheduler.stop(graceMilliseconds),
        server.close(graceMilliseconds),
        // Scheduled, recovered and reported turns run in the background, outside any request.
        Promise.race([dispatcher.idle(), grace]),
      ]);
      clearTimeout(graceTimer);
    },
  };
}
