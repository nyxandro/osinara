/** Only verified PostgreSQL connection failures permit waiting for infrastructure, never replaying effects. */
import { setTimeout as sleep } from "node:timers/promises";
import type { QueryConfig } from "pg";
import { database } from "./database.js";

import { isDatabaseUnavailable } from "./database-errors.js";
export { isDatabaseUnavailable } from "./database-errors.js";

const RECOVERY_PROBE_INTERVAL_MS = 1_000;
const RECOVERY_PROBE_BUDGET_MS = 60_000;
// A probe stuck on a frozen server would outlive the stop signal: the signal cancels the pause
// between probes, not a query already in flight. The read timeout starts once a connection is
// held, and acquiring one is bounded separately at five seconds, so one probe costs at most about
// seven — still inside Docker's default ten for a service without its own stop grace period.
const RECOVERY_PROBE_TIMEOUT_MS = 2_000;
/** node-postgres raises its own read timeout as a plain Error with exactly this message. */
export const PG_QUERY_READ_TIMEOUT_MESSAGE = "Query read timeout";
// pg 8 reads `query_timeout` from the query config itself (lib/client.js), while its type
// definitions declare the field only on the client config; the intersection states it honestly.
const RECOVERY_PROBE: QueryConfig & { query_timeout: number } = {
  text: "SELECT 1",
  query_timeout: RECOVERY_PROBE_TIMEOUT_MS,
};
/**
 * `signal` belongs to a caller whose process can be asked to stop. Without it the probe keeps its
 * timer to the end of the budget, so the process outlives the container grace period and is killed
 * instead of closing its pool — and the abandoned probe opens a fresh pool nobody will close.
 */
export async function waitForApplicationDatabase(signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + RECOVERY_PROBE_BUDGET_MS;
  while (true) {
    signal?.throwIfAborted();
    try {
      await database().query(RECOVERY_PROBE);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      // A probe that ran out of time is the database still not answering, which is what we wait for.
      const probeTimedOut = error instanceof Error && error.message === PG_QUERY_READ_TIMEOUT_MESSAGE;
      if (!probeTimedOut && !isDatabaseUnavailable(error) && code !== "ECONNREFUSED" && code !== "ECONNRESET") {
        throw error;
      }
      if (Date.now() >= deadline) throw error;
      await sleep(RECOVERY_PROBE_INTERVAL_MS, undefined, { signal });
    }
  }
}

/** Only for independently replay-safe bookkeeping, never for work or an external request. */
export async function recoverDatabaseBookkeeping<T>(operation: () => Promise<T>): Promise<T> {
  const maxRecoveries = 3;
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!isDatabaseUnavailable(error) || attempt >= maxRecoveries) throw error;
      console.info(JSON.stringify({ code: "AGENT_DATABASE_BOOKKEEPING_RECOVERY", attempt: attempt + 1 }));
      await waitForApplicationDatabase();
    }
  }
}
