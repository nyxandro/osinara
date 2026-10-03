/**
 * Minute dispatcher for application-managed scheduled agent runs.
 *
 * Export:
 * - `agentScheduleDispatchSchedule`: claims due user-defined scenarios and starts their turns in
 *   Telegram chats.
 * - Records a completed cycle for external monitoring; a failed cycle records nothing.
 */
import type { RuntimeSchedule } from "../runtime/scheduler.js";
import { dispatchDueAgentSchedules, type ScheduledChatStart } from "../lib/agent-schedules/agent-schedule-dispatcher.js";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";
import { withScheduleHeartbeat } from "../lib/schedule-heartbeat.js";

export function agentScheduleDispatchSchedule(startInChat: ScheduledChatStart): RuntimeSchedule {
  return {
    cron: "* * * * *",
    name: "agent-schedule-dispatch",
    run({ waitUntil }) {
      waitUntil(withRuntimeAdmission(
        "ordinary",
        () => withScheduleHeartbeat("agent-schedule-dispatch", () => dispatchDueAgentSchedules(startInChat)),
      ));
    },
  };
}
