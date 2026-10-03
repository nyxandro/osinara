/**
 * Session retention job boundary.
 *
 * Export:
 * - `deleteExpiredSessions`: deletes retired application sessions whose retention has elapsed;
 *   their runtime history, journal and channel addresses go with them (foreign-key cascade).
 */
import { isAppError } from "../app-error.js";
import { sessionRepository } from "./session-repository.js";

export async function deleteExpiredSessions(): Promise<number> {
  // The existing minute lifecycle hook bounds abandoned task rows before deletion.
  await sessionRepository.retireAbandonedTasks(new Date());
  let deleted = 0;
  let parkedThisSweep = 0;
  while (true) {
    const claim = await sessionRepository.claimExpiredForDeletion(new Date());
    if (!claim) {
      if (parkedThisSweep > 0) {
        // The sweep no longer stops, so this line is the only place the pile stays visible.
        console.warn(JSON.stringify({
          code: "AGENT_SESSION_RETENTION_PARKED", deleted, parkedThisSweep,
        }));
      }
      return deleted;
    }

    try {
      await sessionRepository.completeDeletion(claim.id, claim.leaseToken);
      deleted += 1;
    } catch (error) {
      const errorCode = isAppError(error) ? error.code : "AGENT_SESSION_RETENTION_DELETE_FAILED";
      // The row belongs to another worker now; recording a failure on it is not ours to do.
      if (errorCode === "AGENT_SESSION_RETENTION_LEASE_LOST") {
        console.warn(JSON.stringify({
          code: "AGENT_SESSION_RETENTION_LEASE_LOST",
          applicationSessionId: claim.id, agentSessionId: claim.agentSessionId,
        }));
        continue;
      }
      // This schedule is the boundary: persist the context and keep sweeping. Stopping here left
      // every later expired session untouched and dropped the dispatcher's heartbeat for a minute.
      parkedThisSweep += 1;
      await sessionRepository.failDeletion(claim.id, claim.leaseToken, errorCode);
      console.error(JSON.stringify({
        code: "AGENT_SESSION_RETENTION_DELETE_FAILED",
        applicationSessionId: claim.id,
        errorCode,
        agentSessionId: claim.agentSessionId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}
