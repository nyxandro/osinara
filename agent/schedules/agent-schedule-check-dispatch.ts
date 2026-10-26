/**
 * Minute cycle of monitor checks.
 *
 * Export:
 * - `agentScheduleCheckDispatchSchedule`: claims due monitor ticks and runs their checks in the
 *   watched chats' sandboxes; the agent is woken only by what a check finds.
 * - Records a completed cycle for external monitoring; a failed cycle records nothing.
 */
import type { RuntimeSchedule } from "../runtime/scheduler.js";
import type { ScheduleCheckOutcome } from "../lib/agent-schedules/agent-schedule-check-contract.js";
import { dispatchDueScheduleChecks } from "../lib/agent-schedules/agent-schedule-check-dispatcher.js";
import type { ScheduleCheckTarget } from "../lib/agent-schedules/agent-schedule-check-repository.js";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";
import { withScheduleHeartbeat } from "../lib/schedule-heartbeat.js";

export function agentScheduleCheckDispatchSchedule(
  runCheck: (target: ScheduleCheckTarget) => Promise<ScheduleCheckOutcome>,
): RuntimeSchedule {
  return {
    cron: "* * * * *",
    name: "agent-schedule-check-dispatch",
    run({ waitUntil }) {
      waitUntil(withRuntimeAdmission(
        "ordinary",
        () => withScheduleHeartbeat("agent-schedule-check-dispatch", () => dispatchDueScheduleChecks(runCheck)),
      ));
    },
  };
}
