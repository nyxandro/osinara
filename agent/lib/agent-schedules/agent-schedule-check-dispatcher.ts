/**
 * The minute cycle of monitor checks, apart from the scenario dispatcher.
 *
 * Exports:
 * - `createScheduleCheckDispatcher`: claims due monitor ticks and runs their checks side by side.
 * - `dispatchDueScheduleChecks`: the production cycle.
 *
 * A check may take a minute. Run in the scenario dispatcher's cycle, it would hold every scenario
 * and wake-up of every family until it ended; here a slow check only delays other checks.
 */
import { Sema } from "async-sema";

import { AGENT_SCHEDULE_DISPATCH_BATCH_SIZE, AGENT_SCHEDULE_DISPATCH_LEASE_MILLISECONDS } from "./agent-schedule-config.js";
import type { ScheduleCheckOutcome } from "./agent-schedule-check-contract.js";
import { scheduleCheckRepository, type ScheduleCheckTarget } from "./agent-schedule-check-repository.js";
import { createScheduleCheckStep } from "./agent-schedule-check-step.js";
import { agentScheduleDispatchRepository, type ClaimedAgentSchedule } from "./agent-schedule-dispatch-repository.js";

// Checks run side by side, each in its own chat's sandbox; this bounds the sandboxes kept busy.
const PARALLEL_SCHEDULE_CHECKS = 3;

export function createScheduleCheckDispatcher(dependencies: {
  checkMonitor(tick: ClaimedAgentSchedule): Promise<unknown>;
  claimDueMonitors(options: { leaseMilliseconds: number; limit: number; now: Date }): Promise<ClaimedAgentSchedule[]>;
}) {
  return async function dispatchScheduleChecks(now = new Date()): Promise<number> {
    const ticks = await dependencies.claimDueMonitors({
      leaseMilliseconds: AGENT_SCHEDULE_DISPATCH_LEASE_MILLISECONDS,
      limit: AGENT_SCHEDULE_DISPATCH_BATCH_SIZE,
      now,
    });
    const slots = new Sema(PARALLEL_SCHEDULE_CHECKS);
    await Promise.all(ticks.map(async (tick) => {
      await slots.acquire();
      try {
        await dependencies.checkMonitor(tick);
      } catch (error) {
        // The tick keeps its lease; the scheduler's recovery returns it once the lease expires.
        console.error(JSON.stringify({
          code: "AGENT_SCHEDULE_CHECK_DISPATCH_FAILED",
          errorName: error instanceof Error ? error.name : "UnknownError",
          runId: tick.runId,
          scheduleId: tick.id,
        }));
      } finally {
        slots.release();
      }
    }));
    return ticks.length;
  };
}

export function dispatchDueScheduleChecks(
  runCheck: (target: ScheduleCheckTarget) => Promise<ScheduleCheckOutcome>,
  now = new Date(),
): Promise<number> {
  return createScheduleCheckDispatcher({
    checkMonitor: createScheduleCheckStep({
      failClaim: (tick, errorCode) => agentScheduleDispatchRepository.failClaim(tick, errorCode),
      now: () => new Date(),
      repository: scheduleCheckRepository,
      runCheck,
    }),
    claimDueMonitors: (options) => agentScheduleDispatchRepository.claimDueMonitors(options),
  })(now);
}
