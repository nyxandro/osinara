/**
 * Minute dispatcher for application-managed proactive notifications.
 *
 * Export:
 * - `reminderDispatchSchedule`: reminders, expired-session retention, workspace cleanup, physical
 *   cleanup of memory whose soft-delete recovery window has elapsed, and cancellation of Telegram
 *   approvals nobody confirmed in time.
 * - Records a completed cycle for external monitoring; a failed cycle records nothing. The approval
 *   sweep runs beside that cycle, admitted while a deploy drains, as before.
 */
import type { RuntimeSchedule } from "../runtime/scheduler.js";

import { dispatchDueReminders } from "../lib/reminders/reminder-dispatcher.js";
import { purgeSoftDeletedMemory } from "../lib/memory-retention.js";
import { deleteExpiredSessions } from "../lib/sessions/session-retention.js";
import { deleteOrphanedWorkspaces } from "../lib/workspaces/workspace-deletion.js";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";
import { withScheduleHeartbeat } from "../lib/schedule-heartbeat.js";

export function reminderDispatchSchedule(input: {
  /** Cancels the approvals that outlived the confirmation window (`createApprovalTimeoutResolver`). */
  readonly resolveTimedOutApprovals: (now: Date) => Promise<number>;
}): RuntimeSchedule {
  return {
    cron: "* * * * *",
    name: "reminder-dispatch",
    run({ waitUntil }) {
      waitUntil(withRuntimeAdmission("ordinary", () => withScheduleHeartbeat("reminder-dispatch", async () => {
        const results = await Promise.allSettled([
          dispatchDueReminders(), deleteExpiredSessions(), deleteOrphanedWorkspaces(), purgeSoftDeletedMemory(new Date()),
        ]);
        const failed = results.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })));
      // An unanswered approval freezes its chat; its cancellation is admitted while a deploy drains.
      waitUntil(withRuntimeAdmission("callback", () => input.resolveTimedOutApprovals(new Date())));
    },
  };
}
