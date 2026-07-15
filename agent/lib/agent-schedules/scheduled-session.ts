/**
 * Scheduled Eve session helpers for Telegram event handlers.
 *
 * Exports:
 * - `scheduledRunId`: returns the trusted scheduled run id from current or initiator auth.
 * - `isScheduledSession`: identifies background agent runs that should suppress progress UI.
 */
import type { SessionContext } from "eve/context";

function runIdFromAttributes(attributes: Readonly<Record<string, unknown>> | undefined): string | null {
  const runId = attributes?.scheduledRunId;
  return typeof runId === "string" && runId ? runId : null;
}

export function scheduledRunId(ctx: Pick<SessionContext, "session">): string | null {
  return runIdFromAttributes(ctx.session.auth.current?.attributes) ??
    runIdFromAttributes(ctx.session.auth.initiator?.attributes);
}

export function isScheduledSession(ctx: Pick<SessionContext, "session">): boolean {
  return scheduledRunId(ctx) !== null;
}
