/**
 * Authorized filesystem-first workspace binary repository.
 *
 * Exports:
 * - `WorkspaceBinaryFile`: current metadata plus an immutable byte snapshot.
 * - `createWorkspaceBinaryRepository`: direct binary read/write over an authorized resolver.
 * - `workspaceBinaryRepository`: production repository rooted at `/app/workspaces`.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  createWorkspaceFileRecord,
  type WorkspaceFileRecord,
} from "./workspace-file-record.js";
import { detectWorkspaceFileMetadata } from "./workspace-file-metadata.js";
import { validateWorkspacePath } from "./workspace-path.js";
import type {
  WorkspaceAuthorization,
  WorkspaceScope,
} from "./workspace-repository.js";
import { workspaceRepository } from "./workspace-repository.js";
import {
  getWorkspaceStoredFile,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "./workspace-storage.js";

interface WorkspaceResolver {
  mounts(auth: WorkspaceAuthorization): Promise<Array<{
    mountPoint: WorkspaceScope;
    workspaceId: string;
  }>>;
}

export interface WorkspaceBinaryFile {
  bytes: Buffer;
  file: WorkspaceFileRecord;
  workspaceId: string;
}

async function resolveWorkspaceId(
  repository: WorkspaceResolver,
  auth: WorkspaceAuthorization,
  scope: WorkspaceScope,
): Promise<string> {
  const mount = (await repository.mounts(auth)).find((item) => item.mountPoint === scope);
  if (!mount) {
    throw new AppError("AGENT_WORKSPACE_ACCESS_DENIED", "Текущий чат не имеет доступа к этой области файлов");
  }
  return mount.workspaceId;
}

async function previousOperation<T>(client: PoolClient, operationKey: string): Promise<T | null> {
  const result = await client.query<{ result: T }>(
    "SELECT result FROM workspace_operations WHERE operation_key = $1",
    [operationKey],
  );
  return result.rows[0]?.result ?? null;
}

async function readCurrentBinary(
  root: string,
  workspaceId: string,
  scope: WorkspaceScope,
  path: string,
): Promise<WorkspaceBinaryFile> {
  const bytes = await readWorkspaceFile(root, workspaceId, path);
  const stored = await getWorkspaceStoredFile(root, workspaceId, path);
  const metadata = await detectWorkspaceFileMetadata(bytes, stored.path);
  return {
    bytes,
    file: createWorkspaceFileRecord({
      byteSize: stored.byteSize,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: metadata.mediaType,
      path: stored.path,
      scope,
      updatedAt: stored.updatedAt,
    }),
    workspaceId,
  };
}

export function createWorkspaceBinaryRepository(root: string, resolver: WorkspaceResolver) {
  return {
    async readBinary(
      auth: WorkspaceAuthorization,
      scope: WorkspaceScope,
      path: string,
    ): Promise<WorkspaceBinaryFile> {
      const safePath = validateWorkspacePath(path);
      const workspaceId = await resolveWorkspaceId(resolver, auth, scope);
      return await readCurrentBinary(root, workspaceId, scope, safePath);
    },

    async writeBinary(auth: WorkspaceAuthorization, input: {
      bytes: Uint8Array;
      mediaType: string;
      operationKey: string;
      path: string;
      scope: WorkspaceScope;
    }): Promise<WorkspaceFileRecord> {
      const safePath = validateWorkspacePath(input.path);
      const workspaceId = await resolveWorkspaceId(resolver, auth, input.scope);
      const client = await database().connect();
      try {
        await client.query("BEGIN");
        const replay = await previousOperation<WorkspaceFileRecord>(client, input.operationKey);
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }

        // The attachment boundary has already verified mediaType; later reads sniff bytes again.
        await writeWorkspaceFile(root, workspaceId, safePath, input.bytes);
        const stored = await getWorkspaceStoredFile(root, workspaceId, safePath);
        const record = createWorkspaceFileRecord({
          byteSize: stored.byteSize,
          contentSha256: createHash("sha256").update(input.bytes).digest("hex"),
          mediaType: input.mediaType,
          path: stored.path,
          scope: input.scope,
          updatedAt: stored.updatedAt,
        });
        await client.query(
          `INSERT INTO workspace_operations (operation_key, workspace_id, operation_type, result)
           VALUES ($1, $2, 'binary_write', $3)`,
          [input.operationKey, workspaceId, JSON.stringify(record)],
        );
        await client.query("COMMIT");
        return record;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

const WORKSPACE_ROOT = resolve("workspaces");

export const workspaceBinaryRepository = createWorkspaceBinaryRepository(
  WORKSPACE_ROOT,
  workspaceRepository,
);
