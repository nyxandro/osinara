/**
 * One tick of a monitor: run its check without the model and decide whether to wake the agent.
 *
 * Export:
 * - `createScheduleCheckStep`: revalidates the claimed tick, runs the check, and either plans the
 *   next tick or queues a wake-up in the conversation.
 *
 * Key constructs:
 * - The agent is woken by an event, by several broken checks in a row, and always by the tick due
 *   at the end of the window, so a watch never ends without the person hearing how it went.
 * - A check that could not run at all, because the sandbox was unavailable, is not the script's
 *   fault: the tick is skipped and the next one planned, never retried at once.
 */
import { AppError } from "../app-error.js";
import {
  SCHEDULE_CHECK_FAILURES_BEFORE_WAKE,
  type ScheduleCheckOutcome,
  type ScheduleCheckTrigger,
} from "./agent-schedule-check-contract.js";
import type {
  ScheduleCheckState,
  ScheduleCheckTarget,
  ScheduleCheckTick,
  scheduleCheckRepository,
} from "./agent-schedule-check-repository.js";

const CHECK_UNAVAILABLE_CODE = "AGENT_SCHEDULE_CHECK_UNAVAILABLE";

export interface ScheduleCheckStepDependencies {
  failClaim(tick: ScheduleCheckTick, errorCode: string): Promise<void>;
  now(): Date;
  repository: Pick<typeof scheduleCheckRepository, "finishTick" | "loadTarget" | "wake">;
  runCheck(target: ScheduleCheckTarget): Promise<ScheduleCheckOutcome>;
}

type CheckResult = ScheduleCheckOutcome | { kind: "unavailable" };

function failureText(result: CheckResult): string | null {
  if (result.kind === "failed") return `exit code ${result.exitCode}: ${result.detail}`;
  if (result.kind === "unavailable") return `the last check could not run: ${CHECK_UNAVAILABLE_CODE}`;
  return null;
}

function stateAfter(result: CheckResult, target: ScheduleCheckTarget): ScheduleCheckState {
  if (result.kind === "unavailable") {
    return { checked: false, errorCode: CHECK_UNAVAILABLE_CODE, failures: target.checkFailures, unavailable: target.checkUnavailable + 1 };
  }
  if (result.kind === "failed") {
    return { checked: true, errorCode: result.errorCode, failures: target.checkFailures + 1, unavailable: 0 };
  }
  return { checked: true, errorCode: null, failures: 0, unavailable: 0 };
}

function wakeFor(result: CheckResult, state: ScheduleCheckState, last: boolean): { output: string | null; trigger: ScheduleCheckTrigger } | null {
  if (result.kind === "fired") return { output: result.output, trigger: "fired" };
  if (last) return { output: failureText(result), trigger: "expired" };
  if (result.kind === "failed" && state.failures >= SCHEDULE_CHECK_FAILURES_BEFORE_WAKE) {
    return { output: failureText(result), trigger: "failed" };
  }
  return null;
}

export function createScheduleCheckStep(dependencies: ScheduleCheckStepDependencies) {
  return async function checkMonitor(tick: ScheduleCheckTick): Promise<"failed" | "parked" | "queued" | "waiting"> {
    let target: ScheduleCheckTarget | null;
    try {
      target = await dependencies.repository.loadTarget(tick);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "AGENT_SCHEDULE_DESTINATION_REVOKED") throw error;
      await dependencies.failClaim(tick, error.code);
      return "failed";
    }
    if (target === null) return "parked";

    const started = performance.now();
    let result: CheckResult;
    try {
      result = await dependencies.runCheck(target);
    } catch (error) {
      console.error(JSON.stringify({
        code: CHECK_UNAVAILABLE_CODE,
        errorName: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
        runId: tick.runId,
        scheduleId: tick.id,
      }));
      result = { kind: "unavailable" };
    }
    const durationMs = Math.round(performance.now() - started);
    const state = stateAfter(result, target);
    const last = new Date(tick.nextRunAt).getTime() >= target.checkUntil.getTime();
    const wake = wakeFor(result, state, last);
    const now = dependencies.now();
    let finished: "parked" | "queued" | "waiting";
    if (wake === null) {
      await dependencies.repository.finishTick(tick, state, now);
      finished = "waiting";
    } else {
      // A broken script that woke the agent starts counting again, so it is not woken every tick.
      const kept = wake.trigger === "failed" ? { ...state, failures: 0 } : state;
      finished = await dependencies.repository.wake(tick, wake, kept, now);
    }
    // Written once the tick is committed, so the line states what actually happened.
    console.info(JSON.stringify({
      code: "AGENT_SCHEDULE_CHECK",
      durationMs,
      ...(result.kind === "failed" ? { exitCode: result.exitCode } : {}),
      outcome: result.kind,
      result: finished,
      runId: tick.runId,
      scheduleId: tick.id,
      wake: wake?.trigger ?? null,
    }));
    return finished;
  };
}
