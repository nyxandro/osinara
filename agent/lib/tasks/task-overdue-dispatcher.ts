/**
 * Overdue task Telegram dispatch orchestration.
 *
 * Exports:
 * - `createTaskOverdueDispatcher`: injectable lease processor.
 * - `dispatchOverdueTasks`: production dispatcher for the Eve minute schedule.
 */
import { sendTelegramMessage } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import {
  type ClaimedOverdueTask,
  taskOverdueRepository,
} from "./task-overdue-repository.js";

const TASK_OVERDUE_BATCH_SIZE = 25;
const TASK_OVERDUE_LEASE_MILLISECONDS = 5 * 60_000;

interface Dependencies {
  deliver(job: ClaimedOverdueTask): Promise<void>;
  repository: typeof taskOverdueRepository;
}

export async function deliverOverdueTask(job: ClaimedOverdueTask): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("AGENT_TELEGRAM_CONFIG_MISSING: Не задан Telegram bot token");
  const threadId = job.messageThreadId === null ? undefined : Number(job.messageThreadId);
  if (threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId <= 0)) {
    throw new Error("AGENT_TASK_THREAD_INVALID: Некорректная тема Telegram");
  }
  const signal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
  await sendTelegramMessage({
    body: {
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      text: `Семейная задача просрочена больше чем на сутки:\n\n${job.title}`,
    },
    chatId: job.telegramChatId,
    credentials: { botToken },
    fetch: (request, init) => fetch(request, { ...init, signal }),
  });
}

export function createTaskOverdueDispatcher(dependencies: Dependencies) {
  return async function dispatch(now = new Date()): Promise<number> {
    const jobs = await dependencies.repository.claimDue({
      leaseMilliseconds: TASK_OVERDUE_LEASE_MILLISECONDS,
      limit: TASK_OVERDUE_BATCH_SIZE,
      now,
    });
    for (const job of jobs) {
      try {
        await dependencies.repository.markDispatchStarted(job.id, job.leaseToken);
        await dependencies.deliver(job);
        await dependencies.repository.complete(job);
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_TASK_OVERDUE_DELIVERY_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          taskId: job.id,
        }));
        await dependencies.repository.fail(job, "AGENT_TASK_OVERDUE_DELIVERY_FAILED");
      }
    }
    return jobs.length;
  };
}

export const dispatchOverdueTasks = createTaskOverdueDispatcher({
  deliver: deliverOverdueTask,
  repository: taskOverdueRepository,
});
