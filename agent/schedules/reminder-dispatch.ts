/**
 * Eve static minute dispatcher for application-managed proactive notifications.
 *
 * Export:
 * - Default minute schedule for reminders, expired-session retention, purge of Workflow runs left
 *   behind by deleted sessions, workspace cleanup, cancellation of Telegram approvals nobody
 *   confirmed in time, and physical cleanup of memory whose soft-delete recovery window has elapsed.
 * - Records a completed cycle for external monitoring; a failed cycle records nothing.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchDueReminders } from "../lib/reminders/reminder-dispatcher.js";
import { purgeSoftDeletedMemory } from "../lib/memory-retention.js";
import { deleteExpiredSessions } from "../lib/sessions/session-retention.js";
import { purgeConfiguredOrphanedWorkflowRuns } from "../lib/sessions/workflow-orphan-run-purge.js";
import { sweepTimedOutApprovals } from "../lib/telegram-hitl/approval-timeout-sweep.js";
import { deleteOrphanedWorkspaces } from "../lib/workspaces/workspace-deletion.js";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";
import { withScheduleHeartbeat } from "../lib/schedule-heartbeat.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(withRuntimeAdmission("ordinary", () => withScheduleHeartbeat("reminder-dispatch", async () => {
      const results = await Promise.allSettled([
        dispatchDueReminders(), deleteExpiredSessions(), purgeConfiguredOrphanedWorkflowRuns(),
        deleteOrphanedWorkspaces(), purgeSoftDeletedMemory(new Date()),
      ]);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })));
    waitUntil(sweepTimedOutApprovals());
  },
});
