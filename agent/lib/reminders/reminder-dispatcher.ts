/**
 * Reminder dispatch orchestration.
 *
 * Exports:
 * - `createReminderDispatcher`: injectable deterministic lease-to-delivery processor.
 * - `dispatchDueReminders`: production dispatcher used by the Eve minute schedule.
 */
import { isAppError } from "../app-error.js";
import {
  REMINDER_DISPATCH_BATCH_SIZE,
  REMINDER_DISPATCH_LEASE_MILLISECONDS,
} from "./reminder-config.js";
import {
  type ClaimedReminder,
  reminderDispatchRepository,
} from "./reminder-dispatch-repository.js";
import { deliverTelegramReminder } from "./telegram-reminder-delivery.js";

interface ReminderDispatcherRepository {
  claimDue(options: {
    leaseMilliseconds: number;
    limit: number;
    now: Date;
  }): Promise<ClaimedReminder[]>;
  complete(job: ClaimedReminder, completedAt: Date): Promise<void>;
  fail(job: ClaimedReminder, errorCode: string): Promise<void>;
  markDispatchStarted(id: string, leaseToken: string): Promise<void>;
}

interface ReminderDispatcherDependencies {
  deliver(job: ClaimedReminder): Promise<void>;
  repository: ReminderDispatcherRepository;
}

export function createReminderDispatcher(dependencies: ReminderDispatcherDependencies) {
  return async function dispatchReminders(now = new Date()): Promise<number> {
    const jobs = await dependencies.repository.claimDue({
      leaseMilliseconds: REMINDER_DISPATCH_LEASE_MILLISECONDS,
      limit: REMINDER_DISPATCH_BATCH_SIZE,
      now,
    });

    // Sequential delivery bounds Telegram pressure and gives every lease an unambiguous marker order.
    for (const job of jobs) {
      try {
        await dependencies.repository.markDispatchStarted(job.id, job.leaseToken);
        await dependencies.deliver(job);
        await dependencies.repository.complete(job, new Date());
      } catch (error) {
        if (isAppError(error) && error.code === "AGENT_REMINDER_LEASE_STALE") {
          console.error(JSON.stringify({
            code: error.code,
            message: "Reminder lease changed before delivery completed",
            reminderId: job.id,
          }));
          continue;
        }
        await dependencies.repository.fail(job, "AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED");
      }
    }
    return jobs.length;
  };
}

export const dispatchDueReminders = createReminderDispatcher({
  deliver: deliverTelegramReminder,
  repository: reminderDispatchRepository,
});
