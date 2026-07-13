/**
 * Durable PostgreSQL embedding job boundary.
 *
 * Exports:
 * - `MemoryEmbeddingJob`: leased text awaiting local embedding.
 * - `IndexedMemoryEmbeddingChunk`: complete source chunk and vector.
 * - `memoryIndexRepository`: claim, complete, and terminal-failure operations.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_VERSION,
} from "./memory-config.js";

export interface MemoryEmbeddingJob {
  content: string;
  leaseToken: string;
  memoryItemId: string;
}

export interface IndexedMemoryEmbeddingChunk {
  chunkIndex: number;
  content: string;
  embedding: readonly number[];
  endOffset: number;
  startOffset: number;
}

function vectorLiteral(vector: readonly number[]): string {
  if (
    vector.length !== MEMORY_EMBEDDING_DIMENSIONS ||
    !vector.every((value) => Number.isFinite(value))
  ) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_VECTOR_INVALID",
      "Локальный сервис памяти вернул вектор неверного формата",
    );
  }
  return `[${vector.join(",")}]`;
}

export const memoryIndexRepository = {
  async claim(limit: number, leaseMilliseconds: number): Promise<MemoryEmbeddingJob[]> {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new Error("AGENT_MEMORY_EMBEDDING_CLAIM_INVALID: Некорректные параметры lease");
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // An expired lease is ambiguous; without an explicit retry policy it becomes terminally failed.
      const expired = await client.query<{ memory_item_id: string }>(
        `UPDATE memory_embedding_jobs
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             last_error_code = 'AGENT_MEMORY_EMBEDDING_LEASE_EXPIRED', updated_at = now()
         WHERE status = 'leased' AND lease_expires_at < now()
         RETURNING memory_item_id`,
      );
      if (expired.rows.length > 0) {
        await client.query(
          `UPDATE memory_items SET embedding_status = 'failed'
           WHERE id = ANY($1::uuid[])`,
          [expired.rows.map((row) => row.memory_item_id)],
        );
      }

      const result = await client.query<{
        content: string;
        lease_token: string;
        memory_item_id: string;
      }>(
        `WITH candidates AS (
           SELECT job.memory_item_id
           FROM memory_embedding_jobs AS job
           WHERE job.status = 'pending' AND job.attempts = 0
           ORDER BY job.created_at, job.memory_item_id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE memory_embedding_jobs AS job
         SET status = 'leased', attempts = 1, lease_token = gen_random_uuid(),
             lease_expires_at = now() + ($2::text || ' milliseconds')::interval,
             updated_at = now()
         FROM candidates, memory_items AS item
         WHERE job.memory_item_id = candidates.memory_item_id
           AND item.id = job.memory_item_id
         RETURNING job.memory_item_id, job.lease_token::text, item.content`,
        [limit, leaseMilliseconds],
      );
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        content: row.content,
        leaseToken: row.lease_token,
        memoryItemId: row.memory_item_id,
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async complete(
    memoryItemId: string,
    leaseToken: string,
    chunks: readonly IndexedMemoryEmbeddingChunk[],
    modelVersion: string,
  ): Promise<boolean> {
    if (modelVersion !== MEMORY_EMBEDDING_MODEL_VERSION || chunks.length === 0) {
      throw new AppError(
        "AGENT_MEMORY_EMBEDDING_CHUNKS_INVALID",
        "Не удалось сохранить неполный смысловой индекс памяти",
      );
    }
    const validatedChunks = chunks.map((chunk, index) => {
      if (
        chunk.chunkIndex !== index ||
        !chunk.content.trim() ||
        !Number.isInteger(chunk.startOffset) ||
        !Number.isInteger(chunk.endOffset) ||
        chunk.startOffset < 0 ||
        chunk.endOffset <= chunk.startOffset
      ) {
        throw new AppError(
          "AGENT_MEMORY_EMBEDDING_CHUNKS_INVALID",
          "Фрагменты смыслового индекса памяти имеют некорректный порядок",
        );
      }
      return { ...chunk, vector: vectorLiteral(chunk.embedding) };
    });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<{ content: string }>(
        `SELECT item.content
         FROM memory_embedding_jobs AS job
         JOIN memory_items AS item ON item.id = job.memory_item_id
         WHERE job.memory_item_id = $1 AND job.status = 'leased' AND job.lease_token = $2
         FOR UPDATE`,
        [memoryItemId, leaseToken],
      );
      if (!job.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      const sourceContent = job.rows[0]!.content;
      if (validatedChunks.some((chunk) =>
        chunk.endOffset > sourceContent.length ||
        sourceContent.slice(chunk.startOffset, chunk.endOffset) !== chunk.content
      )) {
        throw new AppError(
          "AGENT_MEMORY_EMBEDDING_CHUNKS_INVALID",
          "Фрагменты смыслового индекса не соответствуют актуальному тексту памяти",
        );
      }
      await client.query("DELETE FROM memory_embedding_chunks WHERE memory_item_id = $1", [memoryItemId]);
      for (const chunk of validatedChunks) {
        await client.query(
          `INSERT INTO memory_embedding_chunks
             (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7)`,
          [memoryItemId, chunk.chunkIndex, chunk.content, chunk.startOffset, chunk.endOffset, chunk.vector, modelVersion],
        );
      }
      await client.query(
        "UPDATE memory_items SET embedding_status = 'indexed' WHERE id = $1",
        [memoryItemId],
      );
      await client.query("DELETE FROM memory_embedding_jobs WHERE memory_item_id = $1", [memoryItemId]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async fail(memoryItemId: string, leaseToken: string, errorCode: string): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const failed = await client.query(
        `UPDATE memory_embedding_jobs
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             last_error_code = $3, updated_at = now()
         WHERE memory_item_id = $1 AND status = 'leased' AND lease_token = $2`,
        [memoryItemId, leaseToken, errorCode],
      );
      if (!failed.rowCount) {
        throw new AppError(
          "AGENT_MEMORY_EMBEDDING_LEASE_STALE",
          "Ошибка относится к неактуальной задаче индексации",
        );
      }
      await client.query(
        "UPDATE memory_items SET embedding_status = 'failed' WHERE id = $1",
        [memoryItemId],
      );
      await client.query("DELETE FROM memory_embedding_chunks WHERE memory_item_id = $1", [memoryItemId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
