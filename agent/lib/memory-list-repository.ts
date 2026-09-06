/**
 * PostgreSQL paginated long-term memory reads.
 *
 * Export:
 * - `memoryListRepository.list`: cursor pagination constrained by verified conversation scopes.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { paginationFilterDigest } from "./keyset-pagination.js";
import { MEMORY_LIST_MAX_LIMIT } from "./memory-config.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { liveMemoryReadPredicate } from "./memory-live-read-authorization.js";
import type { ReferencedMemoryItem, ReferencedMemoryRow } from "./memory-record.js";
import { rowToReferencedMemory } from "./memory-record.js";
import {
  MEMORY_REF_PATTERN,
  type ModelMemoryEvidence,
} from "./model-memory.js";

interface MemoryListRow extends ReferencedMemoryRow {
  source_author_label: string;
  source_evidence_kind: ModelMemoryEvidence["kind"];
  source_observed_at: Date;
}

function decodeCursor(
  cursor: string | undefined,
  expectedBinding: string,
): { memoryRef: string; updatedAt: Date } | null {
  if (cursor === undefined) return null;
  const [timestamp, memoryRef, binding, extra] = cursor.split("|");
  const updatedAt = new Date(timestamp ?? "");
  if (
    extra !== undefined ||
    !memoryRef ||
    !MEMORY_REF_PATTERN.test(memoryRef) ||
    binding !== expectedBinding ||
    Number.isNaN(updatedAt.getTime())
  ) {
    throw new AppError("AGENT_MEMORY_CURSOR_INVALID", "Не удалось продолжить просмотр памяти");
  }
  return { memoryRef, updatedAt };
}

export const memoryListRepository = {
  async list(
    auth: MemoryAuthorization,
    options: { cursor?: string; limit: number; scope?: MemoryScope },
  ): Promise<{ items: ReferencedMemoryItem[]; nextCursor: string | null }> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MEMORY_LIST_MAX_LIMIT) {
      throw new AppError("AGENT_MEMORY_LIMIT_INVALID", "Некорректный размер страницы памяти");
    }
    if (options.scope && !auth.scopes.includes(options.scope)) {
      throw new AppError("AGENT_MEMORY_SCOPE_DENIED", "Эта информация недоступна в текущем чате");
    }
    // Bind the opaque cursor to its authorization and filters so it cannot cross result sets.
    const cursorBinding = paginationFilterDigest([
      "memory-ref-v1",
      auth.familyId,
      auth.userId,
      auth.groupId,
      [...auth.scopes].sort().join(","),
      options.scope ?? null,
    ]);
    const cursor = decodeCursor(options.cursor, cursorBinding);
    const result = await database().query<MemoryListRow>(
      `SELECT item.id, item.author_user_id, item.author_telegram_user_id, item.scope, item.kind,
               item.content, item.source, item.confirmation, item.sensitivity,
               item.message_thread_id, item.embedding_status, item.created_at, item.updated_at, item.occurred_at,
               ref.memory_ref,
               COALESCE(source_evidence.evidence_kind, 'unresolved') AS source_evidence_kind,
               COALESCE(source_evidence.observed_at, item.created_at) AS source_observed_at,
               COALESCE(source_evidence.author_label_snapshot, 'Источник не установлен')
                 AS source_author_label
       FROM memory_items AS item
       JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
       LEFT JOIN LATERAL (
         SELECT evidence_kind, observed_at, author_label_snapshot
         FROM claim_evidence WHERE claim_id = item.id AND evidence_role = 'primary'
         ORDER BY observed_at, id LIMIT 1
       ) AS source_evidence ON true
        WHERE item.family_id = $1 AND item.claim_status = 'active'
          AND ($5::memory_scope IS NULL OR item.scope = $5)
           AND ${liveMemoryReadPredicate({
             alias: "item",
             personalIdentityColumn: "owner_user_id",
           })}
          AND ($6::timestamptz IS NULL OR (item.updated_at, ref.memory_ref) < ($6, $7::text))
        ORDER BY item.updated_at DESC, ref.memory_ref DESC
        LIMIT $8`,
      [
        auth.familyId,
        auth.scopes,
        auth.userId,
        auth.groupId,
        options.scope ?? null,
        cursor?.updatedAt ?? null,
        cursor?.memoryRef ?? null,
        options.limit + 1,
      ],
    );
    const hasNext = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        ...rowToReferencedMemory(row),
        sourceEvidence: {
          authorLabel: row.source_author_label,
          kind: row.source_evidence_kind,
          observedAt: row.source_observed_at.toISOString(),
        },
      })),
      nextCursor: hasNext && last
        ? `${last.updated_at.toISOString()}|${last.memory_ref}|${cursorBinding}`
        : null,
    };
  },
};
