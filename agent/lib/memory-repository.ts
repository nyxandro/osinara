/**
 * PostgreSQL long-term memory boundary.
 *
 * Exports:
 * - Re-exported memory record and mutation contracts.
 * - `memoryRepository`: transaction-safe scoped CRUD and retrieval operations.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { memoryListRepository } from "./memory-list-repository.js";
import { enforceMemoryQuota } from "./memory-quota.js";
import {
  memoryOperationHash,
  type CreateMemoryInput,
  type MemoryItem,
  type MemoryKind,
  type MemoryRow,
  type MemorySensitivity,
  rowToMemory,
} from "./memory-record.js";

export type {
  CreateMemoryInput,
  MemoryConfirmation,
  MemoryEmbeddingStatus,
  MemoryItem,
  MemoryKind,
  MemorySensitivity,
} from "./memory-record.js";

interface MutationOperationRow {
  input_hash: string;
  memory_item_id: string | null;
  mutation_kind: "create" | "delete" | "update";
}

function requireScope(auth: MemoryAuthorization, scope: MemoryScope): void {
  if (!auth.scopes.includes(scope)) {
    throw new AppError("AGENT_MEMORY_SCOPE_DENIED", "Эта информация недоступна в текущем чате");
  }
  if (scope === "personal" && !auth.userId) {
    throw new AppError("AGENT_MEMORY_CONTEXT_INVALID", "Не удалось определить владельца личной памяти");
  }
  if (scope === "group" && !auth.groupId) {
    throw new AppError("AGENT_MEMORY_CONTEXT_INVALID", "Не удалось определить группу памяти");
  }
}

async function existingOperation(
  client: PoolClient,
  auth: MemoryAuthorization,
  operationKey: string,
  mutationKind: MutationOperationRow["mutation_kind"],
  inputHash: string,
): Promise<MutationOperationRow | null> {
  const result = await client.query<MutationOperationRow>(
    `SELECT mutation_kind, input_hash, memory_item_id
     FROM memory_mutation_operations
     WHERE family_id = $1 AND operation_key = $2`,
    [auth.familyId, operationKey],
  );
  const operation = result.rows[0];
  if (!operation) return null;
  if (operation.mutation_kind !== mutationKind || operation.input_hash !== inputHash) {
    throw new AppError(
      "AGENT_MEMORY_REPLAY_MISMATCH",
      "Повтор операции памяти не совпадает с исходным запросом",
    );
  }
  return operation;
}

async function selectMemoryById(
  client: PoolClient,
  familyId: string,
  memoryId: string,
  lock = false,
): Promise<MemoryRow | null> {
  const result = await client.query<MemoryRow>(
    `SELECT id, author_user_id, author_telegram_user_id, scope, kind, content, source,
            confirmation, sensitivity, message_thread_id, embedding_status, created_at, updated_at
     FROM memory_items
     WHERE family_id = $1 AND id = $2
     ${lock ? "FOR UPDATE" : ""}`,
    [familyId, memoryId],
  );
  return result.rows[0] ?? null;
}

async function isCurrentFamilyOwner(
  client: PoolClient,
  auth: MemoryAuthorization,
): Promise<boolean> {
  if (!auth.userId) return false;
  const result = await client.query(
    `SELECT 1 FROM family_memberships
     WHERE family_id = $1 AND user_id = $2 AND role = 'owner'`,
    [auth.familyId, auth.userId],
  );
  return Boolean(result.rowCount);
}

async function isCurrentFamilyMember(
  client: PoolClient,
  auth: MemoryAuthorization,
): Promise<boolean> {
  if (!auth.userId) return false;
  const result = await client.query(
    "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2",
    [auth.familyId, auth.userId],
  );
  return Boolean(result.rowCount);
}

async function requireCurrentWriteContext(
  client: PoolClient,
  auth: MemoryAuthorization,
  scope: MemoryScope,
): Promise<void> {
  if (scope !== "group") {
    if (await isCurrentFamilyMember(client, auth)) return;
    throw new AppError("AGENT_ACCESS_DENIED", "Доступ к семейному агенту был отозван");
  }
  const group = await client.query(
    "SELECT 1 FROM telegram_groups WHERE id = $1 AND family_id = $2 FOR SHARE",
    [auth.groupId, auth.familyId],
  );
  if (!group.rowCount) {
    throw new AppError("AGENT_GROUP_NOT_REGISTERED", "Эта группа больше не подключена к агенту");
  }
}

async function requireMutationAccess(
  client: PoolClient,
  auth: MemoryAuthorization,
  memory: MemoryRow,
): Promise<void> {
  requireScope(auth, memory.scope);

  // Personal and family writes require active membership; stale session snapshots cannot mutate data.
  const currentMember = await isCurrentFamilyMember(client, auth);
  const currentOwner = await isCurrentFamilyOwner(client, auth);
  const allowed =
    (memory.scope === "personal" && currentMember && memory.author_user_id === auth.userId) ||
    (memory.scope === "family" &&
      currentMember &&
      (memory.author_user_id === auth.userId || currentOwner)) ||
    (memory.scope === "group" &&
      (memory.author_telegram_user_id === auth.telegramUserId || currentOwner));
  if (!allowed) {
    throw new AppError(
      "AGENT_MEMORY_MUTATION_DENIED",
      "Эту запись может изменить только её автор или владелец семьи",
    );
  }
}

export const memoryRepository = {
  async create(auth: MemoryAuthorization, input: CreateMemoryInput): Promise<MemoryItem> {
    requireScope(auth, input.scope);
    const inputHash = memoryOperationHash(input);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await existingOperation(
        client,
        auth,
        input.operationKey,
        "create",
        inputHash,
      );
      if (replay) {
        const replayed = replay.memory_item_id
          ? await selectMemoryById(client, auth.familyId, replay.memory_item_id)
          : null;
        if (!replayed) {
          throw new AppError(
            "AGENT_MEMORY_REPLAY_COMPLETED",
            "Исходная операция завершена, но запись уже удалена",
          );
        }
        await client.query("COMMIT");
        return rowToMemory(replayed);
      }

      await requireCurrentWriteContext(client, auth, input.scope);
      await enforceMemoryQuota(client, auth, input.scope);
      const ownerUserId = input.scope === "personal" ? auth.userId : null;
      const groupId = input.scope === "group" ? auth.groupId : null;
      const authorUserId = input.scope === "group" ? auth.userId : auth.userId;
      if (input.scope !== "group" && !authorUserId) {
        throw new AppError("AGENT_MEMORY_CONTEXT_INVALID", "Не удалось определить автора памяти");
      }
      const result = await client.query<MemoryRow>(
        `INSERT INTO memory_items
           (family_id, owner_user_id, group_id, author_user_id, author_telegram_user_id,
            scope, kind, content, source, source_event_id, message_thread_id, confirmation,
            sensitivity, operation_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id, author_user_id, author_telegram_user_id, scope, kind, content, source,
                   confirmation, sensitivity, message_thread_id, embedding_status, created_at, updated_at`,
        [
          auth.familyId,
          ownerUserId,
          groupId,
          authorUserId,
          input.scope === "group" ? auth.telegramUserId : null,
          input.scope,
          input.kind,
          input.content,
          input.source,
          input.sourceEventId ?? null,
          input.messageThreadId ?? null,
          input.confirmation,
          input.sensitivity,
          input.operationKey,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("AGENT_MEMORY_WRITE_FAILED: Память не была сохранена");

      // Operation, indexing request, and privacy-safe audit metadata commit with the memory itself.
      await client.query(
        `INSERT INTO memory_mutation_operations
           (family_id, operation_key, mutation_kind, input_hash, memory_item_id)
         VALUES ($1, $2, 'create', $3, $4)`,
        [auth.familyId, input.operationKey, inputHash, row.id],
      );
      await client.query(
        "INSERT INTO memory_embedding_jobs (memory_item_id) VALUES ($1)",
        [row.id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'memory.created', $3,
                 jsonb_build_object('scope', $4::text, 'kind', $5::text, 'sensitivity', $6::text))`,
        [auth.familyId, auth.userId, row.id, input.scope, input.kind, input.sensitivity],
      );
      await client.query("COMMIT");
      return rowToMemory(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async delete(
    auth: MemoryAuthorization,
    id: string,
    operationKey: string,
  ): Promise<{ deleted: true }> {
    const inputHash = memoryOperationHash({ id });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await existingOperation(client, auth, operationKey, "delete", inputHash);
      if (replay) {
        await client.query("COMMIT");
        return { deleted: true };
      }
      const memory = await selectMemoryById(client, auth.familyId, id, true);
      if (!memory) {
        throw new AppError("AGENT_MEMORY_NOT_FOUND", "Запись памяти не найдена");
      }
      await requireMutationAccess(client, auth, memory);

      // Persist idempotency and audit before physical deletion nulls the operation reference.
      await client.query(
        `INSERT INTO memory_mutation_operations
           (family_id, operation_key, mutation_kind, input_hash, memory_item_id)
         VALUES ($1, $2, 'delete', $3, $4)`,
        [auth.familyId, operationKey, inputHash, id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'memory.deleted', $3,
                 jsonb_build_object('scope', $4::text, 'kind', $5::text))`,
        [auth.familyId, auth.userId, id, memory.scope, memory.kind],
      );
      await client.query("DELETE FROM memory_items WHERE id = $1", [id]);
      await client.query("COMMIT");
      return { deleted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  list: memoryListRepository.list,

  async update(
    auth: MemoryAuthorization,
    input: {
      content: string;
      id: string;
      kind?: MemoryKind;
      operationKey: string;
      sensitivity?: MemorySensitivity;
    },
  ): Promise<MemoryItem> {
    const inputHash = memoryOperationHash(input);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await existingOperation(client, auth, input.operationKey, "update", inputHash);
      if (replay?.memory_item_id) {
        const replayed = await selectMemoryById(client, auth.familyId, replay.memory_item_id);
        if (!replayed) {
          throw new AppError("AGENT_MEMORY_NOT_FOUND", "Запись памяти уже удалена");
        }
        await client.query("COMMIT");
        return rowToMemory(replayed);
      }
      const memory = await selectMemoryById(client, auth.familyId, input.id, true);
      if (!memory) {
        throw new AppError("AGENT_MEMORY_NOT_FOUND", "Запись памяти не найдена");
      }
      await requireMutationAccess(client, auth, memory);
      const result = await client.query<MemoryRow>(
        `UPDATE memory_items
         SET content = $2,
             kind = COALESCE($3, kind),
              sensitivity = COALESCE($4, sensitivity),
              confirmation = 'user_confirmed',
              embedding_status = 'pending',
             updated_at = now()
         WHERE id = $1
         RETURNING id, author_user_id, author_telegram_user_id, scope, kind, content, source,
                   confirmation, sensitivity, message_thread_id, embedding_status, created_at, updated_at`,
        [input.id, input.content, input.kind ?? null, input.sensitivity ?? null],
      );
      const row = result.rows[0];
      if (!row) throw new Error("AGENT_MEMORY_UPDATE_FAILED: Память не была обновлена");

      // Corrected text invalidates every previous semantic chunk in the same transaction.
      await client.query("DELETE FROM memory_embedding_chunks WHERE memory_item_id = $1", [input.id]);

      await client.query(
        `INSERT INTO memory_mutation_operations
           (family_id, operation_key, mutation_kind, input_hash, memory_item_id)
         VALUES ($1, $2, 'update', $3, $4)`,
        [auth.familyId, input.operationKey, inputHash, input.id],
      );
      await client.query(
        `INSERT INTO memory_embedding_jobs (memory_item_id, status, attempts, updated_at)
         VALUES ($1, 'pending', 0, now())
         ON CONFLICT (memory_item_id) DO UPDATE
         SET status = 'pending', attempts = 0, lease_token = NULL, lease_expires_at = NULL,
             last_error_code = NULL, updated_at = now()`,
        [input.id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'memory.updated', $3,
                 jsonb_build_object('scope', $4::text, 'kind', $5::text, 'sensitivity', $6::text))`,
        [auth.familyId, auth.userId, input.id, row.scope, row.kind, row.sensitivity],
      );
      await client.query("COMMIT");
      return rowToMemory(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
