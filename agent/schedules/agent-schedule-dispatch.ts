/**
 * Eve static minute dispatcher for application-managed scheduled agent runs.
 *
 * Export:
 * - Default minute schedule that claims due user-defined scenarios and starts Telegram sessions.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchDueAgentSchedules } from "../lib/agent-schedules/agent-schedule-dispatcher.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ receive, waitUntil }) {
    waitUntil(dispatchDueAgentSchedules(receive));
  },
});
