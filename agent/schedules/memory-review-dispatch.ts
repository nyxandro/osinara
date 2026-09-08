/**
 * Eve minute dispatcher for durable silent memory-review batches.
 *
 * Export:
 * - Default schedule that delivers severe alerts and starts ready 50-message task sessions.
 */
import { defineSchedule } from "eve/schedules";
import { withRuntimeAdmission } from "../lib/runtime-maintenance.js";

import { dispatchPendingMemoryReviews } from "../lib/memory-review/memory-review-dispatcher.js";
import { dispatchMemoryReviewOwnerAlerts } from
  "../lib/memory-review/memory-review-owner-alert-dispatcher.js";

async function dispatchMemoryReviewCycle(to: Parameters<typeof dispatchPendingMemoryReviews>[0]) {
  // Alert delivery cannot prevent an independent review claim; a second pass flushes new failures.
  const initial = await Promise.allSettled([
    dispatchMemoryReviewOwnerAlerts(),
    dispatchPendingMemoryReviews(to),
  ]);
  const final = await Promise.allSettled([dispatchMemoryReviewOwnerAlerts()]);
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
    waitUntil(withRuntimeAdmission("ordinary", () => dispatchMemoryReviewCycle(to)));
  },
});
