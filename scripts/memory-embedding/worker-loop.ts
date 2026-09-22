/**
 * The embedding worker's pass loop, separated from the process entrypoint so it can be tested.
 *
 * Exports:
 * - `isTerminalJobFailure`: whether a failed job is the memory's fault or the database being away.
 * - `runEmbeddingWorkerLoop`: claims batches until stopped, pausing while the database is away.
 *
 * Key construct:
 * - Waiting for infrastructure is not a hidden retry of work. The database restarts by itself, and
 *   on both restarts so far this worker died on the first claim, was restarted by Docker into a
 *   database still recovering, and died again. `waitForApplicationDatabase` is the mechanism the
 *   inbound message path already uses for exactly this, and its budget is bounded: past that the
 *   container restart is the right answer after all.
 */
import { isDatabaseUnavailable } from "../../agent/lib/database-errors.js";

export interface EmbeddingWorkerLoopDependencies {
  isStopping: () => boolean;
  markAlive: () => Promise<void>;
  processBatch: () => Promise<number>;
  sleep: (milliseconds: number) => Promise<void>;
  waitForDatabase: () => Promise<void>;
}

const IDLE_POLL_MILLISECONDS = 1_000;

/**
 * A database outage says nothing about the memory being indexed. Recording it as the job's own
 * failure would drop that memory out of semantic search for good, and only an operator could
 * bring it back.
 */
export function isTerminalJobFailure(error: unknown): boolean {
  return !isDatabaseUnavailable(error);
}

export async function runEmbeddingWorkerLoop(
  dependencies: EmbeddingWorkerLoopDependencies,
): Promise<void> {
  while (!dependencies.isStopping()) {
    let processed: number;
    try {
      processed = await dependencies.processBatch();
    } catch (error) {
      if (!isDatabaseUnavailable(error)) throw error;
      // Visible on purpose: a silent pause and a hung worker look the same from outside.
      console.info(JSON.stringify({
        code: "AGENT_MEMORY_EMBEDDING_WORKER_WAITING",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      await dependencies.waitForDatabase();
      continue;
    }
    // Also on an empty pass: an idle worker is healthy, a stuck one is not, and only the loop
    // itself knows the difference.
    await dependencies.markAlive();
    if (processed === 0) await dependencies.sleep(IDLE_POLL_MILLISECONDS);
  }
}
