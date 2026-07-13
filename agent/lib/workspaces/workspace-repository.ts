/**
 * Authorized filesystem-first workspace repository.
 *
 * Exports:
 * - `WorkspaceAuthorization`, file metadata, and scope types: public contracts.
 * - `createWorkspaceRepository`: direct filesystem operations behind current access checks.
 * - `workspaceRepository`: production repository rooted at `/app/workspaces`.
 */
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  type WorkspaceFileRecord,
  type WorkspaceScope,
} from "./workspace-file-record.js";
import { validateWorkspacePath } from "./workspace-path.js";
import {
  deleteWorkspaceFile,
} from "./workspace-storage.js";

export type {
  WorkspaceFileRecord,
  WorkspaceScope,
} from "./workspace-file-record.js";

export interface WorkspaceAuthorization {
  familyId: string;
  groupId: string | null;
  groupType: "external_private" | "external_public" | "family_private" | null;
  role: "external" | "member" | "owner" | "recovery_owner";
  telegramChatType: "group" | "private" | "supergroup";
  userId: string | null;
}

interface WorkspaceRow {
  id: string;
  scope: WorkspaceScope;
}

async function assertCurrentAccess(
  client: PoolClient,
  auth: WorkspaceAuthorization,
  scope: WorkspaceScope,
): Promise<void> {
  if (scope === "personal") {
    if (auth.telegramChatType !== "private" || !auth.userId) {
      throw new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Личный workspace доступен только в личном чате");
    }
  } else if (scope === "family") {
    if (!auth.userId || auth.role === "external") {
      throw new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Семейный workspace доступен только участникам семьи");
    }
    if (auth.groupId) {
      const group = await client.query(
        `SELECT 1 FROM telegram_groups
          WHERE id = $1 AND family_id = $2 AND type = 'family_private'`,
        [auth.groupId, auth.familyId],
      );
      if (group.rowCount !== 1) {
        throw new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Этот чат не имеет доступа к семейному workspace");
      }
    }
  } else {
    if (!auth.groupId || auth.telegramChatType === "private") {
      throw new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Групповой workspace доступен только в своей группе");
    }
    const group = await client.query(
      `SELECT 1 FROM telegram_groups
        WHERE id = $1 AND family_id = $2 AND type IN ('external_private', 'external_public')`,
      [auth.groupId, auth.familyId],
    );
    if (group.rowCount !== 1) {
      throw new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Группа не имеет собственного workspace");
    }
    return;
  }

  // Personal and family access is recalculated from current membership on every operation.
  const membership = await client.query(
    "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2",
    [auth.familyId, auth.userId],
  );
  if (membership.rowCount !== 1) {
    throw new AppError("AGENT_WORKSPACE_ACCESS_REVOKED", "Доступ к workspace был отозван");
  }
}

async function resolveWorkspace(
  client: PoolClient,
  auth: WorkspaceAuthorization,
  scope: WorkspaceScope,
): Promise<WorkspaceRow> {
  await assertCurrentAccess(client, auth, scope);
  const result = await client.query<WorkspaceRow>(
    `INSERT INTO workspaces (family_id, owner_user_id, group_id, scope)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (family_id, scope, owner_user_id, group_id) DO UPDATE
       SET family_id = EXCLUDED.family_id
     RETURNING id, scope`,
    [
      auth.familyId,
      scope === "personal" ? auth.userId : null,
      scope === "group" ? auth.groupId : null,
      scope,
    ],
  );
  return result.rows[0]!;
}

async function previousOperation<T>(client: PoolClient, operationKey: string): Promise<T | null> {
  const result = await client.query<{ result: T }>(
    "SELECT result FROM workspace_operations WHERE operation_key = $1",
    [operationKey],
  );
  return result.rows[0]?.result ?? null;
}

async function saveOperation(
  client: PoolClient,
  operationKey: string,
  workspaceId: string,
  type: string,
  result: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_operations (operation_key, workspace_id, operation_type, result)
     VALUES ($1, $2, $3, $4)`,
    [operationKey, workspaceId, type, JSON.stringify(result)],
  );
}

export function createWorkspaceRepository(root: string) {
  return {
    async mounts(auth: WorkspaceAuthorization): Promise<Array<{
      mountPoint: WorkspaceScope;
      workspaceId: string;
    }>> {
      const scopes: WorkspaceScope[] = auth.telegramChatType === "private"
        ? ["personal", "family"]
        : auth.groupType === "family_private"
        ? ["family"]
        : auth.groupType === "external_private" || auth.groupType === "external_public"
        ? ["group"]
        : [];
      if (scopes.length === 0) {
        throw new AppError("AGENT_WORKSPACE_CONTEXT_INVALID", "Для текущего чата не определён workspace");
      }
      const client = await database().connect();
      try {
        const mounts = [];
        for (const scope of scopes) {
          const workspace = await resolveWorkspace(client, auth, scope);
          mounts.push({ mountPoint: scope, workspaceId: workspace.id });
        }
        return mounts;
      } finally {
        client.release();
      }
    },

    async deleteFile(
      auth: WorkspaceAuthorization,
      scope: WorkspaceScope,
      path: string,
      operationKey: string,
    ): Promise<{ deleted: boolean }> {
      const safePath = validateWorkspacePath(path);
      const client = await database().connect();
      try {
        await client.query("BEGIN");
        const replay = await previousOperation<{ deleted: boolean }>(client, operationKey);
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }
        const workspace = await resolveWorkspace(client, auth, scope);
        const result = { deleted: await deleteWorkspaceFile(root, workspace.id, safePath) };
        await saveOperation(client, operationKey, workspace.id, "delete", result);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export const workspaceRepository = createWorkspaceRepository(resolve("workspaces"));
