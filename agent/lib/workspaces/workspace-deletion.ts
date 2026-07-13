/**
 * Durable physical workspace deletion queue.
 *
 * Exports:
 * - `createWorkspaceDeletionWorker`: dependency-injected worker for integration tests.
 * - `deleteOrphanedWorkspaces`: leases cascade-generated jobs and removes volume directories.
 */
import { resolve } from "node:path";

import { WORKSPACE_DELETION_LEASE_MS } from "../../config.js";
import { isAppError } from "../app-error.js";
import { database } from "../database.js";
import { deleteRunnerToolEnvironment } from "../sandbox-runner/runner-sandbox-backend.js";
import { deleteWorkspaceDirectory } from "./workspace-storage.js";

export function createWorkspaceDeletionWorker(
  root: string,
  deleteToolEnvironment: (workspaceId: string) => Promise<void>,
) {
  return async function deleteWorkspaces(): Promise<number> {
    let deleted = 0;
    while (true) {
      const now = new Date();
      const leaseToken = crypto.randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + WORKSPACE_DELETION_LEASE_MS);
      const claim = await database().query<{ workspace_id: string }>(
        `UPDATE workspace_deletion_jobs
          SET lease_token = $2, lease_expires_at = $3
        WHERE workspace_id = (
          SELECT workspace_id FROM workspace_deletion_jobs
           WHERE available_at <= $1
             AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
           ORDER BY available_at, workspace_id
           LIMIT 1 FOR UPDATE SKIP LOCKED
        )
      RETURNING workspace_id`,
        [now, leaseToken, leaseExpiresAt],
      );
      const workspaceId = claim.rows[0]?.workspace_id;
      if (!workspaceId) return deleted;
      try {
        await deleteWorkspaceDirectory(root, workspaceId);
        await deleteToolEnvironment(workspaceId);
        const completed = await database().query(
          "DELETE FROM workspace_deletion_jobs WHERE workspace_id = $1 AND lease_token = $2",
          [workspaceId, leaseToken],
        );
        if (completed.rowCount !== 1) throw new Error("AGENT_WORKSPACE_DELETION_LEASE_LOST");
        deleted += 1;
      } catch (error) {
        const errorCode = isAppError(error) ? error.code : "AGENT_WORKSPACE_PHYSICAL_DELETE_FAILED";
        await database().query(
          `UPDATE workspace_deletion_jobs
            SET error_code = $3, lease_token = NULL, lease_expires_at = NULL
          WHERE workspace_id = $1 AND lease_token = $2`,
          [workspaceId, leaseToken, errorCode],
        );
        console.error("Workspace physical deletion failed", { error, errorCode, workspaceId });
        throw error;
      }
    }
  };
}

export const deleteOrphanedWorkspaces = createWorkspaceDeletionWorker(
  resolve("workspaces"),
  deleteRunnerToolEnvironment,
);
