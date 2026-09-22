/**
 * Durable local memory embedding worker entrypoint.
 *
 * Constructs:
 * - Claims bounded PostgreSQL batches and calls the pinned local TEI service.
 * - Completes each lease atomically or records one terminal failure without hidden retries.
 * - A database restart is a pause, not the end: the pass loop waits for it inside a bounded budget.
 * - Publishes readiness on every pass so a hung loop becomes an unhealthy container.
 * - Stops gracefully on SIGINT/SIGTERM and releases the database pool.
 */
import { rm, writeFile } from "node:fs/promises";

import { isAppError } from "../agent/lib/app-error.js";
import { closeDatabase } from "../agent/lib/database.js";
import { waitForApplicationDatabase } from "../agent/lib/database-recovery.js";
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
  MEMORY_EMBEDDING_WORKER_READY_PATH,
  MEMORY_EMBEDDING_WORKER_STARTED_CODE,
} from "../agent/lib/memory-config.js";
import { memoryIndexRepository } from "../agent/lib/memory-index-repository.js";
import { isTerminalJobFailure, runEmbeddingWorkerLoop } from "./memory-embedding/worker-loop.js";

let stopping = false;
let requestStop!: () => void;
// Settles on the first stop signal so a database wait in flight does not outlive the grace period.
const stopRequested = new Promise<void>((resolve) => { requestStop = resolve; });

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string {
  return isAppError(error) ? error.code : "AGENT_MEMORY_EMBEDDING_UNEXPECTED";
}

/** The heartbeat: touched after every job, so a slow pass is not mistaken for a stuck one. */
async function markAlive(): Promise<void> {
  await writeFile(MEMORY_EMBEDDING_WORKER_READY_PATH, "ready\n", { encoding: "utf8", mode: 0o600 });
}

async function processBatch(): Promise<number> {
  const jobs = await memoryIndexRepository.claim(
    MEMORY_EMBEDDING_JOB_BATCH_SIZE,
    MEMORY_EMBEDDING_LEASE_MILLISECONDS,
  );
  if (jobs.length === 0) return 0;

  // Each parent is all-or-nothing: provider batches are bounded, then every chunk commits together.
  for (const job of jobs) {
    await markAlive();
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
      // The database being away is not a verdict on this memory, so it is not recorded as one:
      // the loop waits the outage out and the lease expires on its own. The record still leaves
      // the semantic index until an operator reindexes it — returning the lease is the other half
      // of #254 and is not decided here — but the reason written down is now the true one.
      if (!isTerminalJobFailure(error)) throw error;
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    requestStop();
  });
}

// A container restart reuses its writable layer, so stale readiness must be cleared before work.
await rm(MEMORY_EMBEDDING_WORKER_READY_PATH, { force: true });
// One line at start, and only at start. It removes the ambiguity this worker used to live in:
// an empty log meant «no errors», and that is exactly what a hung process looks like too. The
// heartbeat is the readiness file, not the log — a pulse in the log would drown the codes.
console.info(JSON.stringify({
  code: MEMORY_EMBEDDING_WORKER_STARTED_CODE,
  batchSize: MEMORY_EMBEDDING_JOB_BATCH_SIZE,
  model: MEMORY_EMBEDDING_MODEL_VERSION,
}));

try {
  await runEmbeddingWorkerLoop({
    isStopping: () => stopping,
    markAlive,
    processBatch,
    sleep,
    stopRequested,
    waitForDatabase: waitForApplicationDatabase,
  });
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
