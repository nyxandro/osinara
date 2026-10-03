/**
 * Minute dispatcher for durable silent memory-review batches.
 *
 * Export:
 * - `memoryReviewDispatchSchedule`: delivers severe alerts and starts ready review turns: a full
 *   50-message batch, or a shorter one whose oldest message has waited out its age limit. It also
 *   releases deploy admissions of processes that are gone.
 * - Records a completed cycle for external monitoring; a failed cycle records nothing.
 */
import type { RuntimeSchedule } from "../runtime/scheduler.js";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";
import { withScheduleHeartbeat } from "../lib/schedule-heartbeat.js";
import { dispatchOperationalIncidents } from "../lib/operational-incidents/owner-alerts.js";
import { reconcileRuntimeAdmissions } from "../lib/runtime-admission-reconciliation.js";

import { dispatchPendingMemoryReviews, type MemoryReviewStart } from "../lib/memory-review/memory-review-dispatcher.js";
import { dispatchMemoryReviewOwnerAlerts } from
  "../lib/memory-review/memory-review-owner-alert-dispatcher.js";

async function dispatchMemoryReviewCycle(startReview: MemoryReviewStart) {
  // Alert delivery cannot prevent an independent review claim; a second pass flushes new failures.
  const initial = await Promise.allSettled([
    dispatchOperationalIncidents(),
    dispatchMemoryReviewOwnerAlerts(),
    dispatchPendingMemoryReviews(startReview),
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

export function memoryReviewDispatchSchedule(startReview: MemoryReviewStart): RuntimeSchedule {
  return {
    cron: "* * * * *",
    name: "memory-review-dispatch",
    run({ waitUntil }) {
      waitUntil(reconcileRuntimeAdmissions());
      waitUntil(withRuntimeAdmission(
        "ordinary",
        () => withScheduleHeartbeat("memory-review-dispatch", () => dispatchMemoryReviewCycle(startReview)),
      ));
    },
  };
}
