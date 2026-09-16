/**
 * Proof of life for the application's periodic dispatchers.
 *
 * Exports:
 * - `SCHEDULE_HEARTBEAT_CODE`: stable code external monitoring matches on.
 * - `ScheduleName`: the four dispatchers that report, as a closed set.
 * - `withScheduleHeartbeat`: runs one dispatcher cycle and records it only when it completed.
 *
 * A stopped scheduler produces no error: reminders simply never arrive. The only observable
 * difference between a healthy minute and a dead one is this line, so it is written after the
 * cycle succeeds and never written when it fails.
 *
 * Placement matters as much as the line itself. This wrapper must sit INSIDE the runtime
 * admission gate, because that gate returns without running the work while the application is
 * draining or frozen. Wrapped the other way round it would report a healthy heartbeat for
 * minutes during which nothing was dispatched at all, which is exactly the outage it exists to
 * reveal. `agent/lib/schedule-heartbeat.test.ts` locks that order in.
 */
export const SCHEDULE_HEARTBEAT_CODE = "AGENT_SCHEDULE_TICK";

/** Names are a closed set so a typo cannot reach runtime and silence a dispatcher's heartbeat. */
export type ScheduleName =
  | "agent-schedule-dispatch"
  | "memory-review-dispatch"
  | "reminder-dispatch"
  | "software-update-check";

export async function withScheduleHeartbeat<T>(
  schedule: ScheduleName,
  run: () => Promise<T>,
): Promise<T> {
  const result = await run();
  console.info(JSON.stringify({ code: SCHEDULE_HEARTBEAT_CODE, schedule }));
  return result;
}
