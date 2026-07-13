/**
 * PostgreSQL personal memory export boundary.
 *
 * Exports:
 * - `memoryExportRepository`: reserves delivery, reads a personal snapshot, and records outcome.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { MemoryItem, MemoryRow } from "./memory-record.js";
import { rowToMemory } from "./memory-record.js";

export const memoryExportRepository = {
  async begin(auth: MemoryAuthorization, operationKey: string): Promise<MemoryItem[]> {
    if (!auth.userId || !auth.scopes.includes("personal")) {
      throw new AppError(
        "AGENT_MEMORY_EXPORT_SCOPE_DENIED",
        "Личную память можно экспортировать только из личного чата",
      );
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const member = await client.query(
        "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 FOR SHARE",
        [auth.familyId, auth.userId],
      );
      if (!member.rowCount) {
        throw new AppError("AGENT_ACCESS_DENIED", "Доступ к семейному агенту был отозван");
      }
      const inserted = await client.query(
        `INSERT INTO memory_exports (family_id, operation_key, requested_by, status)
         VALUES ($1, $2, $3, 'started')
         ON CONFLICT DO NOTHING`,
        [auth.familyId, operationKey, auth.userId],
      );
      if (!inserted.rowCount) {
        const existing = await client.query<{ requested_by: string; status: string }>(
          `SELECT requested_by, status FROM memory_exports
           WHERE family_id = $1 AND operation_key = $2`,
          [auth.familyId, operationKey],
        );
        const exportRow = existing.rows[0];
        if (!exportRow || exportRow.requested_by !== auth.userId) {
          throw new AppError(
            "AGENT_MEMORY_EXPORT_REPLAY_MISMATCH",
            "Повтор экспорта не совпадает с исходным запросом",
          );
        }
        if (exportRow.status === "completed") {
          throw new AppError("AGENT_MEMORY_EXPORT_ALREADY_DELIVERED", "Экспорт уже отправлен");
        }
        if (exportRow.status === "started") {
          throw new AppError(
            "AGENT_MEMORY_EXPORT_DELIVERY_AMBIGUOUS",
            "Не удалось подтвердить доставку прошлого экспорта. Проверьте документы в чате перед новым запросом",
          );
        }
        throw new AppError(
          "AGENT_MEMORY_EXPORT_PREVIOUSLY_FAILED",
          "Прошлая отправка экспорта завершилась ошибкой. Создайте новый запрос",
        );
      }
      const result = await client.query<MemoryRow>(
        `SELECT id, author_user_id, author_telegram_user_id, scope, kind, content, source,
                confirmation, sensitivity, message_thread_id, embedding_status, created_at, updated_at
         FROM memory_items
         WHERE family_id = $1 AND scope = 'personal' AND owner_user_id = $2
         ORDER BY created_at, id`,
        [auth.familyId, auth.userId],
      );
      await client.query("COMMIT");
      return result.rows.map(rowToMemory);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async complete(auth: MemoryAuthorization, operationKey: string): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE memory_exports SET status = 'completed', completed_at = now()
         WHERE family_id = $1 AND operation_key = $2 AND requested_by = $3 AND status = 'started'`,
        [auth.familyId, operationKey, auth.userId],
      );
      if (!result.rowCount) {
        throw new Error("AGENT_MEMORY_EXPORT_STATE_INVALID: Экспорт не находился в состоянии отправки");
      }
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, metadata)
         VALUES ($1, $2, 'memory.exported', jsonb_build_object('format', 'json+markdown'))`,
        [auth.familyId, auth.userId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async fail(auth: MemoryAuthorization, operationKey: string, failureCode: string): Promise<void> {
    await database().query(
      `UPDATE memory_exports SET status = 'failed', failure_code = $4
       WHERE family_id = $1 AND operation_key = $2 AND requested_by = $3 AND status = 'started'`,
      [auth.familyId, operationKey, auth.userId, failureCode],
    );
  },
};
