/**
 * Durable immediate-undo boundary for long-term memory creates.
 *
 * Exports:
 * - `MemoryUndoInput`: verified Eve call/session/turn identity for one undo attempt.
 * - `MEMORY_UNDO_DENIED_MESSAGE`: stable user-facing denial with a safe next step.
 * - `memoryUndoRepository`: provenance eligibility and atomic replay-safe undo operations.
 *
 * Key constructs:
 * - Historical rows without explicit provenance never qualify.
 * - Eligibility requires the unchanged create from the same verified user, session, and turn.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryOperationHash, type MemoryOperationProvenance, type MemoryRow } from "./memory-record.js";

export const MEMORY_UNDO_DENIED_MESSAGE =
  "Без подтверждения можно отменить только неизменённую запись, созданную вами в текущем действии. Для другой записи запросите отдельное удаление";

export interface MemoryUndoInput extends MemoryOperationProvenance {
  operationKey: string;
}

interface MutationOperationRow {
  actor_telegram_user_id: string | null;
  actor_user_id: string | null;
  eve_session_id: string | null;
  eve_turn_id: string | null;
  input_hash: string;
  mutation_kind: "create" | "delete" | "update";
}

const MEMORY_COLUMNS = `item.id, item.author_user_id, item.author_telegram_user_id, item.scope,
  item.kind, item.content, item.source, item.confirmation, item.sensitivity,
  item.message_thread_id, item.embedding_status, item.created_at, item.updated_at, item.occurred_at`;

function undoDenied(): AppError {
  return new AppError(
    "AGENT_MEMORY_UNDO_DENIED",
    MEMORY_UNDO_DENIED_MESSAGE,
  );
}

async function existingUndo(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: MemoryUndoInput,
  inputHash: string,
): Promise<boolean> {
  const result = await client.query<MutationOperationRow>(
    `SELECT mutation_kind, input_hash, actor_user_id, actor_telegram_user_id,
            eve_session_id, eve_turn_id
     FROM memory_mutation_operations
     WHERE family_id = $1 AND operation_key = $2`,
    [auth.familyId, input.operationKey],
  );
  const operation = result.rows[0];
  if (!operation) return false;
  const sameProvenance =
    operation.actor_user_id === auth.userId &&
    operation.actor_telegram_user_id === auth.telegramUserId &&
    operation.eve_session_id === input.sessionId &&
    operation.eve_turn_id === input.turnId;
  if (
    operation.mutation_kind !== "delete" ||
    operation.input_hash !== inputHash ||
    !sameProvenance
  ) {
    throw new AppError(
      "AGENT_MEMORY_REPLAY_MISMATCH",
      "Повтор операции памяти не совпадает с исходным запросом",
    );
  }
  return true;
}

async function selectImmediateUndoCandidate(
  client: PoolClient,
  auth: MemoryAuthorization,
  id: string,
  provenance: MemoryOperationProvenance,
): Promise<MemoryRow | null> {
  const result = await client.query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS}
     FROM memory_items AS item
     JOIN memory_mutation_operations AS creation
       ON creation.family_id = item.family_id
      AND creation.operation_key = item.operation_key
      AND creation.memory_item_id = item.id
      AND creation.mutation_kind = 'create'
     WHERE item.family_id = $1
       AND item.id = $2
       AND item.scope = ANY($3::memory_scope[])
       AND creation.actor_user_id IS NOT DISTINCT FROM $4::uuid
       AND creation.actor_telegram_user_id = $5
       AND creation.eve_session_id = $6
       AND creation.eve_turn_id = $7
       AND (
         (item.scope IN ('personal', 'family')
           AND item.author_user_id = $4
           AND EXISTS (
             SELECT 1 FROM family_memberships AS membership
             WHERE membership.family_id = item.family_id AND membership.user_id = $4
           ))
         OR
         (item.scope = 'group'
           AND item.group_id = $8
           AND item.author_telegram_user_id = $5
           AND EXISTS (
             SELECT 1 FROM telegram_groups AS telegram_group
             WHERE telegram_group.id = item.group_id AND telegram_group.family_id = item.family_id
           ))
       )
       AND NOT EXISTS (
         SELECT 1 FROM memory_mutation_operations AS later
         WHERE later.family_id = item.family_id
           AND later.memory_item_id = item.id
           AND later.mutation_kind <> 'create'
       )
    `,
    [
      auth.familyId,
      id,
      auth.scopes,
      auth.userId,
      auth.telegramUserId,
      provenance.sessionId,
      provenance.turnId,
      auth.groupId,
    ],
  );
  return result.rows[0] ?? null;
}

async function lockMemoryItem(
  client: PoolClient,
  auth: MemoryAuthorization,
  id: string,
): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM memory_items WHERE family_id = $1 AND id = $2 FOR UPDATE",
    [auth.familyId, id],
  );
  return Boolean(result.rowCount);
}

export const memoryUndoRepository = {
  async canUndoCreate(
    auth: MemoryAuthorization,
    id: string,
    provenance: MemoryOperationProvenance,
  ): Promise<boolean> {
    const client = await database().connect();
    try {
      return Boolean(await selectImmediateUndoCandidate(client, auth, id, provenance));
    } finally {
      client.release();
    }
  },

  async undoCreate(
    auth: MemoryAuthorization,
    id: string,
    input: MemoryUndoInput,
  ): Promise<{ deleted: true }> {
    const inputHash = memoryOperationHash({ id });
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // A completed identical call remains successful after the target row has been deleted.
      if (await existingUndo(client, auth, input, inputHash)) {
        await client.query("COMMIT");
        return { deleted: true };
      }

      // Lock first, then evaluate provenance so a concurrent update cannot pass a stale predicate.
      if (!await lockMemoryItem(client, auth, id)) throw undoDenied();
      const memory = await selectImmediateUndoCandidate(client, auth, id, input);
      if (!memory) throw undoDenied();

      // Operation and privacy-safe audit commit before the physical delete nulls item references.
      await client.query(
        `INSERT INTO memory_mutation_operations
           (family_id, operation_key, mutation_kind, input_hash, memory_item_id,
            actor_user_id, actor_telegram_user_id, eve_session_id, eve_turn_id)
         VALUES ($1, $2, 'delete', $3, $4, $5, $6, $7, $8)`,
        [
          auth.familyId,
          input.operationKey,
          inputHash,
          id,
          auth.userId,
          auth.telegramUserId,
          input.sessionId,
          input.turnId,
        ],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'memory.deleted', $3,
                 jsonb_build_object('scope', $4::text, 'kind', $5::text, 'reason', 'immediate_undo'))`,
        [auth.familyId, auth.userId, id, memory.scope, memory.kind],
      );
      // Отмена создания тоже мягкая: единый путь означает, что ни одна операция памяти не уносит
      // данные безвозвратно, а ретенция вычищает мягко удалённое позже.
      await client.query(
        `UPDATE memory_items_all
            SET deleted_at = now(), claim_status = 'retracted'
          WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      await client.query("DELETE FROM memory_embedding_jobs WHERE memory_item_id = $1", [id]);
      await client.query("COMMIT");
      return { deleted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
