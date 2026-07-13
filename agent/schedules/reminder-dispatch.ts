/**
 * Eve static minute dispatcher for application-managed proactive notifications.
 *
 * Export:
 * - Default minute schedule for notifications and expired-session retention.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchDueReminders } from "../lib/reminders/reminder-dispatcher.js";
import { deleteExpiredSessions } from "../lib/sessions/session-retention.js";
import { dispatchOverdueTasks } from "../lib/tasks/task-overdue-dispatcher.js";
import { deleteOrphanedWorkspaces } from "../lib/workspaces/workspace-deletion.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(Promise.all([
      dispatchDueReminders(),
      dispatchOverdueTasks(),
      deleteExpiredSessions(),
      deleteOrphanedWorkspaces(),
    ]));
  },
});
