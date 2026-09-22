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
import { isDatabaseUnavailable } from "../../agent/lib/database-recovery.js";
import { MEMORY_EMBEDDING_WORKER_WAITING_CODE } from "../../agent/lib/memory-config.js";

export interface EmbeddingWorkerLoopDependencies {
  markAlive: () => Promise<void>;
  processBatch: () => Promise<number>;
  sleep: (milliseconds: number) => Promise<void>;
  /** Aborted on SIGINT and SIGTERM: one source of truth about the shutdown, shared with the wait. */
  stopSignal: AbortSignal;
  waitForDatabase: (signal: AbortSignal) => Promise<void>;
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
  let waiting = false;
  while (!dependencies.stopSignal.aborted) {
    let processed: number;
    try {
      processed = await dependencies.processBatch();
    } catch (error) {
      if (!isDatabaseUnavailable(error)) throw error;
      // Visible on purpose, and once: a silent pause and a hung worker look the same from outside,
      // while a line per turn of the loop would bury the codes that matter.
      if (!waiting) {
        console.info(JSON.stringify({
          code: MEMORY_EMBEDDING_WORKER_WAITING_CODE,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
        waiting = true;
      }
      // The heartbeat belongs here too: waiting for the database is the process working correctly,
      // and the readiness file does not depend on the database.
      await dependencies.markAlive();
      // Docker gives the container ten seconds after SIGTERM while this wait is allowed sixty, so
      // the wait carries the stop signal: it is cancelled, not merely stopped being awaited.
      try {
        await dependencies.waitForDatabase(dependencies.stopSignal);
      } catch (waitError) {
        if (dependencies.stopSignal.aborted) return;
        // The budget ran out: the container restart is the right answer after all.
        throw waitError;
      }
      // The probe can pass while the work still fails — `too many clients` answers `SELECT 1` on an
      // open connection and refuses a new one — and then this loop would spin without the pause.
      await dependencies.sleep(IDLE_POLL_MILLISECONDS);
      continue;
    }
    waiting = false;
    // Also on an empty pass: an idle worker is healthy, a stuck one is not, and only the loop
    // itself knows the difference.
    await dependencies.markAlive();
    if (processed === 0) await dependencies.sleep(IDLE_POLL_MILLISECONDS);
  }
}
