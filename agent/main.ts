/**
 * The agent process: the one backend that receives Telegram, runs turns and the minute schedules.
 *
 * Start, in order:
 * 1. The runtime: Osinara's agent, the model call, sandboxes, compaction, and an observer per
 *    channel (Telegram delivers, the memory review only records how its turn ended).
 * 2. Recovery: turns an earlier process left running continue from the journal.
 * 3. The HTTP server on the addresses Eve had: the Telegram webhook, the internal drain the
 *    ingress worker calls, the Google OAuth callback and the health check.
 * 4. The minute scheduler: reminders and approval timeouts, scheduled runs, memory review, the
 *    software update check, and recovery again for turns whose start a deploy held back.
 *
 * Stop (SIGTERM, SIGINT): no new requests or schedule cycles; running work gets a bounded time.
 * What is still running then continues at the next start from the journal: a turn is never marked
 * cancelled by a stopping process.
 */
import { createTelegramIngress, telegramChannelHooks, telegramTurnEvents } from "./channels/telegram.js";
import { googleOAuthRoutes } from "./channels/google-oauth.js";
import { createMemoryReviewStart, MEMORY_REVIEW_CHANNEL_KIND, memoryReviewTurnEvents } from "./channels/memory-review.js";
import { createOsinaraAgent } from "./agent.js";
import { TELEGRAM_INGRESS_LEASE_MS } from "./config.js";
import { AGENT_SCHEDULE_CONVERSATION_ADMISSION_MILLISECONDS } from "./lib/agent-schedules/agent-schedule-config.js";
import type { ScheduledChatStart } from "./lib/agent-schedules/agent-schedule-dispatcher.js";
import { createConversationWakeupProcessor } from "./lib/conversation-wakeups/conversation-wakeup-drain.js";
import { conversationWakeupRepository } from "./lib/conversation-wakeups/conversation-wakeup-repository.js";
import { createConversationWakeupTurn } from "./lib/conversation-wakeups/conversation-wakeup-turn-start.js";
import { closeDatabase, database } from "./lib/database.js";
import { runtimeProcessIdentity } from "./lib/runtime-admission-reconciliation.js";
import { withRuntimeAdmission } from "./lib/runtime-maintenance.js";
import { createApprovalTimeoutResolver } from "./lib/telegram-hitl/approval-timeout.js";
import { finalizeTimedOutPrompt } from "./lib/telegram-hitl/approval-timeout-prompt.js";
import { approvalTimeoutRepository } from "./lib/telegram-hitl/approval-timeout-repository.js";
import { createTurnDispatcher } from "./runtime/dispatch.js";
import { respondInSession } from "./runtime/respond.js";
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

// The port Docker, Nginx, the ingress worker and the deploy controller already use.
const HTTP_PORT = 3000;
const HTTP_HOST = "0.0.0.0";
const TELEGRAM_WEBHOOK_ROUTE = "/eve/v1/telegram";
const TELEGRAM_DRAIN_ROUTE = "/eve/v1/telegram-drain";
// Docker stops a container ten seconds after SIGTERM; the database is closed inside that window.
const SHUTDOWN_GRACE_MILLISECONDS = 8_000;
// A waiting turn checks again this often when no turn of this process signals that its session moved on.
const TURN_WAIT_MILLISECONDS = 1_000;

function requiredEnv(name: "TELEGRAM_BOT_TOKEN" | "TELEGRAM_BOT_USERNAME" | "TELEGRAM_WEBHOOK_SECRET_TOKEN"): string {
  const value = process.env[name];
  if (!value) throw new Error(`AGENT_CONFIG_MISSING: ${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const db = database();
  const identity = await runtimeProcessIdentity();
  const telegram = createTelegramChannel({
    botToken: requiredEnv("TELEGRAM_BOT_TOKEN"),
    botUsername: requiredEnv("TELEGRAM_BOT_USERNAME"),
    database: db,
    events: telegramTurnEvents,
    ...telegramChannelHooks,
  });
  const dispatcher = createTurnDispatcher({
    // A turn that already exists may finish while a deploy drains, never once it is frozen.
    admit: (work) => withRuntimeAdmission("callback", work),
    runtime: {
      agent: createOsinaraAgent(),
      callModel: callStepModel,
      database: db,
      observer: routeTurnObservers({
        [MEMORY_REVIEW_CHANNEL_KIND]: lifecycleTurnObserver(memoryReviewTurnEvents),
        telegram: telegram.observer,
      }),
      runnerId: `${identity.hostname}:${identity.pid}:${identity.startTicks}`,
      sandbox: createSessionSandboxes({ database: db }),
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
  const server = await startRuntimeServer({
    host: HTTP_HOST,
    port: HTTP_PORT,
    routes: [
      ...telegramWebhookRoutes({
        drainRoute: TELEGRAM_DRAIN_ROUTE,
        onDrain: (context) => ingress.drain(context),
        onVerifiedUpdate: (context) => ingress(context),
        route: TELEGRAM_WEBHOOK_ROUTE,
        webhookSecretToken: requiredEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
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

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info(JSON.stringify({ code: "AGENT_RUNTIME_STOPPING", signal }));
    await Promise.all([scheduler.stop(SHUTDOWN_GRACE_MILLISECONDS), server.close(SHUTDOWN_GRACE_MILLISECONDS)]);
    await closeDatabase();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ code: "AGENT_RUNTIME_START_FAILED", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
