/**
 * Operator-triggered memory reindex entrypoint.
 *
 * Constructs:
 * - Resets failed, missing, or incompatible E5 chunk sets to pending.
 * - Creates one fresh durable job per affected memory without running provider calls itself.
 */
import { closeDatabase, database } from "../agent/lib/database.js";
import { MEMORY_EMBEDDING_MODEL_VERSION } from "../agent/lib/memory-config.js";

const client = await database().connect();
try {
  await client.query("BEGIN");
  const candidates = await client.query<{ id: string }>(
    `SELECT item.id
     FROM memory_items AS item
     WHERE item.embedding_status <> 'indexed'
        OR NOT EXISTS (
          SELECT 1 FROM memory_embedding_chunks AS chunk
          WHERE chunk.memory_item_id = item.id AND chunk.embedding_model = $1
        )
        OR EXISTS (
          SELECT 1 FROM memory_embedding_chunks AS chunk
          WHERE chunk.memory_item_id = item.id AND chunk.embedding_model <> $1
        )
     FOR UPDATE`,
    [MEMORY_EMBEDDING_MODEL_VERSION],
  );
  if (candidates.rows.length > 0) {
    const ids = candidates.rows.map((row) => row.id);
    await client.query(
      "DELETE FROM memory_embedding_chunks WHERE memory_item_id = ANY($1::uuid[])",
      [ids],
    );
    await client.query(
      "UPDATE memory_items SET embedding_status = 'pending' WHERE id = ANY($1::uuid[])",
      [ids],
    );
    await client.query(
      `INSERT INTO memory_embedding_jobs (memory_item_id)
       SELECT unnest($1::uuid[])
       ON CONFLICT (memory_item_id) DO UPDATE
       SET status = 'pending', attempts = 0, lease_token = NULL, lease_expires_at = NULL,
           last_error_code = NULL, updated_at = now()`,
      [ids],
    );
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({
    code: "AGENT_MEMORY_REINDEX_QUEUED",
    modelVersion: MEMORY_EMBEDDING_MODEL_VERSION,
    queued: candidates.rows.length,
  }));
} catch (error) {
  await client.query("ROLLBACK");
  console.error(JSON.stringify({
    code: "AGENT_MEMORY_REINDEX_FAILED",
    errorName: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  }));
  throw error;
} finally {
  client.release();
  await closeDatabase();
}
