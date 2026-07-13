/**
 * PostgreSQL paginated long-term memory reads.
 *
 * Export:
 * - `memoryListRepository.list`: cursor pagination constrained by verified conversation scopes.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { MEMORY_LIST_MAX_LIMIT } from "./memory-config.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import type { MemoryItem, MemoryRow } from "./memory-record.js";
import { rowToMemory } from "./memory-record.js";

function decodeCursor(cursor: string | undefined): { id: string; updatedAt: Date } | null {
  if (!cursor) return null;
  const [timestamp, id, extra] = cursor.split("|");
  const updatedAt = new Date(timestamp ?? "");
  if (extra !== undefined || !id || Number.isNaN(updatedAt.getTime())) {
    throw new AppError("AGENT_MEMORY_CURSOR_INVALID", "Не удалось продолжить просмотр памяти");
  }
  return { id, updatedAt };
}

export const memoryListRepository = {
  async list(
    auth: MemoryAuthorization,
    options: { cursor?: string; limit: number; scope?: MemoryScope },
  ): Promise<{ items: MemoryItem[]; nextCursor: string | null }> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MEMORY_LIST_MAX_LIMIT) {
      throw new AppError("AGENT_MEMORY_LIMIT_INVALID", "Некорректный размер страницы памяти");
    }
    if (options.scope && !auth.scopes.includes(options.scope)) {
      throw new AppError("AGENT_MEMORY_SCOPE_DENIED", "Эта информация недоступна в текущем чате");
    }
    const cursor = decodeCursor(options.cursor);
    const result = await database().query<MemoryRow>(
      `SELECT id, author_user_id, author_telegram_user_id, scope, kind, content, source,
              confirmation, sensitivity, message_thread_id, embedding_status, created_at, updated_at
       FROM memory_items
       WHERE family_id = $1
         AND ($5::memory_scope IS NULL OR scope = $5)
         AND (
           (scope = 'personal' AND 'personal' = ANY($2::memory_scope[]) AND owner_user_id = $3) OR
           (scope = 'family' AND 'family' = ANY($2::memory_scope[])) OR
           (scope = 'group' AND 'group' = ANY($2::memory_scope[]) AND group_id = $4)
         )
         AND ($6::timestamptz IS NULL OR (updated_at, id) < ($6, $7::uuid))
       ORDER BY updated_at DESC, id DESC
       LIMIT $8`,
      [
        auth.familyId,
        auth.scopes,
        auth.userId,
        auth.groupId,
        options.scope ?? null,
        cursor?.updatedAt ?? null,
        cursor?.id ?? null,
        options.limit + 1,
      ],
    );
    const hasNext = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(rowToMemory),
      nextCursor: hasNext && last ? `${last.updated_at.toISOString()}|${last.id}` : null,
    };
  },
};
