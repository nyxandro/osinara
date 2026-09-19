/**
 * Eve minute dispatcher for durable silent memory-review batches.
 *
 * Export:
 * - Default schedule that delivers severe alerts and starts ready task sessions: a full
 *   50-message batch, or a shorter one whose oldest message has waited out its age limit.
 * - Records a completed cycle for external monitoring; a failed cycle records nothing.
 */
import { defineSchedule } from "eve/schedules";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";
import { withScheduleHeartbeat } from "../lib/schedule-heartbeat.js";
import { dispatchOperationalIncidents } from "../lib/operational-incidents/owner-alerts.js";
import { reconcileRuntimeAdmissions } from "../lib/runtime-admission-reconciliation.js";

import { dispatchPendingMemoryReviews } from "../lib/memory-review/memory-review-dispatcher.js";
import { dispatchMemoryReviewOwnerAlerts } from
  "../lib/memory-review/memory-review-owner-alert-dispatcher.js";

async function dispatchMemoryReviewCycle(to: Parameters<typeof dispatchPendingMemoryReviews>[0]) {
  // Alert delivery cannot prevent an independent review claim; a second pass flushes new failures.
  const initial = await Promise.allSettled([
    dispatchOperationalIncidents(),
    dispatchMemoryReviewOwnerAlerts(),
    dispatchPendingMemoryReviews(to),
  ]);
  const final = await Promise.allSettled([dispatchMemoryReviewOwnerAlerts(), dispatchOperationalIncidents()]);
  const failures = [...initial, ...final].filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length === 0) return;
  for (const failure of failures) {
    console.error(JSON.stringify({
      code: "AGENT_MEMORY_REVIEW_SCHEDULE_FAILED",
      errorName: failure.reason instanceof Error ? failure.reason.name : "UnknownError",
      errorMessage: failure.reason instanceof Error
        ? failure.reason.message
        : String(failure.reason),
    }));
  }
  throw failures[0]!.reason;
}

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil }) {
    waitUntil(reconcileRuntimeAdmissions());
    waitUntil(withRuntimeAdmission(
      "ordinary",
      () => withScheduleHeartbeat("memory-review-dispatch", () => dispatchMemoryReviewCycle(to)),
    ));
  },
});
