/**
 * Schedule for application-owned software update proposals.
 *
 * Export:
 * - `softwareUpdateCheckSchedule`: every six hours (00, 06, 12, 18), no model or channel session.
 * - Records a completed cycle for external monitoring; a failed cycle records nothing.
 */
import type { RuntimeSchedule } from "../runtime/scheduler.js";

import { runSoftwareUpdateCheck } from "../lib/software-updates/release-checker.js";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";
import { withScheduleHeartbeat } from "../lib/schedule-heartbeat.js";

async function runScheduledSoftwareUpdateCheck(): Promise<void> {
  try {
    await runSoftwareUpdateCheck();
  } catch (error) {
    // The schedule boundary adds structured context; the scheduler logs that the cycle failed.
    console.error(JSON.stringify({
      code: "AGENT_SOFTWARE_UPDATE_CHECK_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }
}

export function softwareUpdateCheckSchedule(): RuntimeSchedule {
  return {
    cron: "0 */6 * * *",
    name: "software-update-check",
    run({ waitUntil }) {
      waitUntil(withRuntimeAdmission(
        "ordinary",
        () => withScheduleHeartbeat("software-update-check", () => runScheduledSoftwareUpdateCheck()),
      ));
    },
  };
}
