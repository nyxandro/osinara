/**
 * PostgreSQL Workflow session retention job boundary.
 *
 * Export:
 * - `deleteExpiredSessions`: globally serializes, leases, and physically deletes retired Eve sessions.
 */
import { isAppError } from "../app-error.js";
import { database } from "../database.js";
import { sessionRepository } from "./session-repository.js";
import { deleteConfiguredPostgresEveSession } from "./workflow-postgres-session-storage.js";

const SESSION_RETENTION_ADVISORY_LOCK_KEY = "osinara-eve-session-retention";

export async function deleteExpiredSessions(): Promise<number> {
  // Per-session leases allow parallel workers, but world-local hook indexes are shared across runs.
  // Hold one dedicated connection for the complete physical sweep and destroy it to release the lock
  // even when filesystem cleanup throws before PostgreSQL can be contacted again.
  const lockClient = await database().connect();
  let acquired = false;
  try {
    const lock = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [SESSION_RETENTION_ADVISORY_LOCK_KEY],
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) return 0;

    return await deleteExpiredSessionsUnderLock();
  } finally {
    lockClient.release(acquired);
  }
}

async function deleteExpiredSessionsUnderLock(): Promise<number> {
  // The existing minute lifecycle hook bounds abandoned task rows before physical Eve deletion.
  await sessionRepository.retireAbandonedTasks(new Date());
  let deleted = 0;
  while (true) {
    const claim = await sessionRepository.claimExpiredForDeletion(new Date());
    if (!claim) return deleted;

    try {
      await deleteConfiguredPostgresEveSession(claim.eveSessionId);
      await sessionRepository.completeDeletion(claim.id, claim.leaseToken);
      deleted += 1;
    } catch (error) {
      const errorCode = isAppError(error) ? error.code : "AGENT_SESSION_RETENTION_DELETE_FAILED";
      // Workflow no longer holds the run, so there is nothing left to delete there and the
      // application row would otherwise wait for storage that will never answer.
      if (errorCode === "AGENT_EVE_SESSION_STORAGE_MISSING") {
        await sessionRepository.completeDeletion(claim.id, claim.leaseToken);
        deleted += 1;
        console.info(JSON.stringify({
          code: "AGENT_SESSION_RETENTION_STORAGE_ABSENT",
          applicationSessionId: claim.id, eveSessionId: claim.eveSessionId,
        }));
        continue;
      }
      // This schedule is the boundary: persist the context and keep sweeping. Stopping here left
      // every later expired session untouched and dropped the dispatcher's heartbeat for a minute.
      await sessionRepository.failDeletion(claim.id, claim.leaseToken, errorCode, new Date());
      console.error("Session retention deletion failed", {
        applicationSessionId: claim.id,
        error,
        errorCode,
        eveSessionId: claim.eveSessionId,
      });
    }
  }
}
