/** Only verified PostgreSQL connection failures permit waiting for infrastructure, never replaying effects. */
import { setTimeout as sleep } from "node:timers/promises";
import { database } from "./database.js";

import { isDatabaseUnavailable } from "./database-errors.js";
export { isDatabaseUnavailable } from "./database-errors.js";

const RECOVERY_PROBE_INTERVAL_MS = 1_000;
const RECOVERY_PROBE_BUDGET_MS = 60_000;
export async function waitForApplicationDatabase(): Promise<void> {
  const deadline = Date.now() + RECOVERY_PROBE_BUDGET_MS;
  while (true) {
    try { await database().query("SELECT 1"); return; }
    catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (!isDatabaseUnavailable(error) && code !== "ECONNREFUSED" && code !== "ECONNRESET") throw error;
      if (Date.now() >= deadline) throw error;
      await sleep(RECOVERY_PROBE_INTERVAL_MS);
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
