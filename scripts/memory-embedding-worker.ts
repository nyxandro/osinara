/**
 * Durable local memory embedding worker entrypoint.
 *
 * Constructs:
 * - Claims bounded PostgreSQL batches and calls the pinned local TEI service.
 * - Completes each lease atomically or records one terminal failure without hidden retries.
 * - Stops gracefully on SIGINT/SIGTERM and releases the database pool.
 */
import { isAppError } from "../agent/lib/app-error.js";
import { closeDatabase } from "../agent/lib/database.js";
import { chunkMemoryContent } from "../agent/lib/memory-embedding-chunks.js";
import { fitMemoryChunksToTokenLimit } from "../agent/lib/memory-embedding-fitting.js";
import { memoryEmbeddingInput } from "../agent/lib/memory-embedding-header.js";
import {
  countMemoryPassageTokens,
  embedMemoryPassages,
} from "../agent/lib/memory-embedding-client.js";
import {
  MEMORY_EMBEDDING_JOB_BATCH_SIZE,
  MEMORY_EMBEDDING_LEASE_MILLISECONDS,
  MEMORY_EMBEDDING_MODEL_VERSION,
  MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE,
} from "../agent/lib/memory-config.js";
import { memoryIndexRepository } from "../agent/lib/memory-index-repository.js";

const IDLE_POLL_MILLISECONDS = 1_000;
let stopping = false;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string {
  return isAppError(error) ? error.code : "AGENT_MEMORY_EMBEDDING_UNEXPECTED";
}

async function processBatch(): Promise<number> {
  const jobs = await memoryIndexRepository.claim(
    MEMORY_EMBEDDING_JOB_BATCH_SIZE,
    MEMORY_EMBEDDING_LEASE_MILLISECONDS,
  );
  if (jobs.length === 0) return 0;

  // Each parent is all-or-nothing: provider batches are bounded, then every chunk commits together.
  for (const job of jobs) {
    if (job.attempts > 1) {
      // A retry happens only after a recorded transient outage, so it must be visible: without
      // this line, a record quietly cycling between failed and leased looks like an idle worker.
      console.info(JSON.stringify({
        // Deliberately outside the AGENT_MEMORY_EMBEDDING_* family: that prefix is what the
        // embedding-failure alert watches, and a retry is a recovery step, not a new failure.
        code: "AGENT_MEMORY_INDEX_RETRY_CLAIMED",
        attempts: job.attempts,
        memoryItemId: job.memoryItemId,
      }));
    }
    try {
      // The model sees the chunk with its subject header; the stored chunk stays an exact slice
      // of the record, so the index can always be checked against the text it came from.
      const withHeader = (chunk: { content: string }) => memoryEmbeddingInput(chunk.content, job);
      const fitted = await fitMemoryChunksToTokenLimit({
        chunks: chunkMemoryContent(job.content),
        content: job.content,
        measure: (candidates) => countMemoryPassageTokens(candidates.map(withHeader)),
        onSplit: (tokens) => console.info(JSON.stringify({
          code: "AGENT_MEMORY_INDEX_CHUNK_RESPLIT",
          memoryItemId: job.memoryItemId,
          tokens,
        })),
      });
      const chunks = fitted.map((chunk, index) => ({
        ...chunk,
        chunkIndex: index,
        embeddingInput: withHeader(chunk),
      }));
      const embeddings: number[][] = [];
      for (let offset = 0; offset < chunks.length; offset += MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE) {
        embeddings.push(...await embedMemoryPassages(
          chunks
            .slice(offset, offset + MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE)
            .map((chunk) => chunk.embeddingInput),
        ));
      }
      const completed = await memoryIndexRepository.complete(
        job.memoryItemId,
        job.leaseToken,
        chunks.map((chunk, index) => ({ ...chunk, embedding: embeddings[index]! })),
        MEMORY_EMBEDDING_MODEL_VERSION,
      );
      if (completed) continue;
      console.error(JSON.stringify({
        code: "AGENT_MEMORY_EMBEDDING_LEASE_STALE",
        memoryItemId: job.memoryItemId,
        message: "Memory embedding completion was rejected",
      }));
    } catch (error) {
      const code = errorCode(error);
      console.error(JSON.stringify({
        code,
        errorName: error instanceof Error ? error.name : "UnknownError",
        memoryItemId: job.memoryItemId,
        message: "Memory embedding job failed terminally",
      }));
      try {
        await memoryIndexRepository.fail(job.memoryItemId, job.leaseToken, code);
      } catch (failureError) {
        if (!isAppError(failureError) || failureError.code !== "AGENT_MEMORY_EMBEDDING_LEASE_STALE") {
          throw failureError;
        }
      }
    }
  }
  return jobs.length;
}

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

try {
  while (!stopping) {
    const processed = await processBatch();
    if (processed === 0) await sleep(IDLE_POLL_MILLISECONDS);
  }
} catch (error) {
  console.error(JSON.stringify({
    code: "AGENT_MEMORY_EMBEDDING_WORKER_FAILED",
    errorName: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  }));
  throw error;
} finally {
  await closeDatabase();
}
