/**
 * Eve static minute dispatcher for application-managed scheduled agent runs.
 *
 * Export:
 * - Default minute schedule that claims due user-defined scenarios and starts Telegram sessions.
 * - Records a completed cycle for external monitoring; a failed cycle records nothing.
 */
import { defineSchedule } from "eve/schedules";

import { dispatchDueAgentSchedules } from "../lib/agent-schedules/agent-schedule-dispatcher.js";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";
import { withScheduleHeartbeat } from "../lib/schedule-heartbeat.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    // Keep the cron task alive while Eve's channel source starts every claimed session.
    waitUntil(withScheduleHeartbeat(
      "agent-schedule-dispatch",
      () => withRuntimeAdmission("ordinary", () => dispatchDueAgentSchedules(to)),
    ));
  },
});
