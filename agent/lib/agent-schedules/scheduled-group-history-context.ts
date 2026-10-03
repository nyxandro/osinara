/**
 * Verified auth projection for run-bound scheduled group-history access.
 *
 * Exports:
 * - `ScheduledGroupHistoryAccess`: exact run and group identity carried by scheduled auth.
 * - `scheduledGroupHistoryAccess`: fail-closed current/initiator projection for root and child turns.
 */
import type { SessionAuth } from "../../runtime/context.js";

export interface ScheduledGroupHistoryAccess {
  groupId: string;
  runId: string;
}

function access(principal: SessionAuth["current"]): ScheduledGroupHistoryAccess | null {
  const attributes = principal?.attributes;
  const scopes = attributes?.memoryScopes;
  if (
    principal?.authenticator !== "telegram" ||
    principal.principalType !== "user" ||
    attributes?.groupType !== "external" ||
    attributes.scheduledGroupHistory !== "enabled" ||
    !Array.isArray(scopes) ||
    scopes.length !== 1 ||
    scopes[0] !== "group" ||
    typeof attributes.groupId !== "string" ||
    typeof attributes.scheduledRunId !== "string"
  ) {
    return null;
  }
  return { groupId: attributes.groupId, runId: attributes.scheduledRunId };
}

export function scheduledGroupHistoryAccess(auth: SessionAuth): ScheduledGroupHistoryAccess | null {
  const current = access(auth.current);
  const initiator = access(auth.initiator);
  // A current caller must independently prove the same scheduled run as its durable initiator.
  if (!current || !initiator) return null;
  return current.groupId === initiator.groupId && current.runId === initiator.runId ? current : null;
}
