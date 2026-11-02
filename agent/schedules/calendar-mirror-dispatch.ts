/**
 * Minute schedule of the reminder ↔ Google Calendar mirror.
 *
 * Export:
 * - `calendarMirrorDispatchSchedule`: every minute, each connected Google profile takes in the
 *   person's calendar edits and writes the reminders out. A cycle still running skips the minute.
 */
import type { RuntimeSchedule } from "../runtime/scheduler.js";

import { reconcileCalendarMirrors } from "../lib/calendar-mirror/calendar-mirror-reconciler.js";
import { productionReconcilerDependencies } from "../lib/calendar-mirror/calendar-mirror-runtime.js";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";

export function calendarMirrorDispatchSchedule(): RuntimeSchedule {
  return {
    cron: "* * * * *",
    name: "calendar-mirror",
    run({ waitUntil }) {
      waitUntil(withRuntimeAdmission("ordinary", () => reconcileCalendarMirrors(productionReconcilerDependencies(), new Date())));
    },
  };
}
