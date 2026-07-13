/**
 * Eve schedule for application-owned software update proposals.
 *
 * Export:
 * - Default six-hour handler schedule with no model or channel session.
 */
import { defineSchedule } from "eve/schedules";

import { runSoftwareUpdateCheck } from "../lib/software-updates/release-checker.js";

async function runScheduledSoftwareUpdateCheck(): Promise<void> {
  try {
    await runSoftwareUpdateCheck();
  } catch (error) {
    // The schedule boundary adds structured context, while Eve retains the original failure.
    console.error(JSON.stringify({
      code: "AGENT_SOFTWARE_UPDATE_CHECK_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }
}

export default defineSchedule({
  cron: "0 */6 * * *",
  run({ waitUntil }) {
    waitUntil(runScheduledSoftwareUpdateCheck());
  },
});
