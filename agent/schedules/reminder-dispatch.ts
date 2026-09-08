/**
 * Eve static minute dispatcher for application-managed proactive notifications.
 *
 * Export:
 * - Default minute schedule for reminders, expired-session retention, workspace cleanup,
 *   cancellation of Telegram approvals nobody confirmed in time, and physical cleanup of memory
 *   whose soft-delete recovery window has elapsed.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchDueReminders } from "../lib/reminders/reminder-dispatcher.js";
import { purgeSoftDeletedMemory } from "../lib/memory-retention.js";
import { deleteExpiredSessions } from "../lib/sessions/session-retention.js";
import { sweepTimedOutApprovals } from "../lib/telegram-hitl/approval-timeout-sweep.js";
import { deleteOrphanedWorkspaces } from "../lib/workspaces/workspace-deletion.js";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(withRuntimeAdmission("ordinary", async () => {
      const results = await Promise.allSettled([
        dispatchDueReminders(), deleteExpiredSessions(), deleteOrphanedWorkspaces(),
        purgeSoftDeletedMemory(new Date()),
      ]);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }));
    waitUntil(sweepTimedOutApprovals());
  },
});
