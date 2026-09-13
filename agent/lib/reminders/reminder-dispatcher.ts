/**
 * Reminder dispatch orchestration.
 *
 * Exports:
 * - `createReminderDispatcher`: injectable deterministic lease-to-delivery processor.
 * - `dispatchDueReminders`: production dispatcher used by the Eve minute schedule.
 */
import { isAppError } from "../app-error.js";
import { recoverDatabaseBookkeeping } from "../database-recovery.js";
import type { ProactiveDeliveryReceipt } from "../proactive-deliveries/proactive-delivery-repository.js";
import {
  REMINDER_DISPATCH_BATCH_SIZE,
  REMINDER_DISPATCH_LEASE_MILLISECONDS,
} from "./reminder-config.js";
import {
  type ClaimedReminder,
  reminderDispatchRepository,
} from "./reminder-dispatch-repository.js";
import { deliverTelegramReminder } from "./telegram-reminder-delivery.js";
import {
  telegramGroupJournalRepository,
  type TelegramGroupJournalRepository,
} from "../telegram-group-journal-repository.js";

interface ReminderDispatcherRepository {
  claimDue(options: {
    leaseMilliseconds: number;
    limit: number;
    now: Date;
  }): Promise<ClaimedReminder[]>;
  complete(
    job: ClaimedReminder,
    completedAt: Date,
    receipt: ProactiveDeliveryReceipt,
  ): Promise<void>;
  fail(job: ClaimedReminder, errorCode: string): Promise<void>;
  markDispatchStarted(id: string, leaseToken: string): Promise<void>;
}

interface ReminderDispatcherDependencies {
  deliver(job: ClaimedReminder): Promise<ProactiveDeliveryReceipt>;
  repository: ReminderDispatcherRepository;
  timeline: Pick<TelegramGroupJournalRepository, "recordAgentResponse">;
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
      let completedAt: Date;
      let receipt: ProactiveDeliveryReceipt;
      try {
        await dependencies.repository.markDispatchStarted(job.id, job.leaseToken);
        receipt = await dependencies.deliver(job);
        completedAt = new Date();
        // Completion atomically records the proactive receipt before any secondary projection.
        await recoverDatabaseBookkeeping(() => dependencies.repository.complete(job, completedAt, receipt));
      } catch (error) {
        if (isAppError(error) && error.code === "AGENT_REMINDER_LEASE_STALE") {
          console.error(JSON.stringify({
            code: error.code,
            message: "Reminder lease changed before delivery completed",
            reminderId: job.id,
          }));
          continue;
        }
        const errorCode = isAppError(error)
          ? error.code
          : "AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED";
        await dependencies.repository.fail(job, errorCode);
        continue;
      }
      if (job.groupId) {
        // A timeline outage propagates for observability but cannot reclassify confirmed delivery.
        await dependencies.timeline.recordAgentResponse({
          applicationSessionId: null,
          contentText: receipt.text,
          deliveredAt: completedAt,
          groupId: job.groupId,
          messageThreadId: job.forumTopicId,
          replyToEntryId: null,
          telegramMessageIds: [receipt.messageId],
        });
      }
    }
    return jobs.length;
  };
}

export const dispatchDueReminders = createReminderDispatcher({
  deliver: deliverTelegramReminder,
  repository: reminderDispatchRepository,
  timeline: telegramGroupJournalRepository,
});
