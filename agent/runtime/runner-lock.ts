/**
 * One agent process per database: the PostgreSQL advisory lock the process holds while it runs.
 *
 * Export:
 * - `acquireRunnerLock`: takes the lock on a connection of its own, held for the process's
 *   lifetime, or fails with `AGENT_RUNTIME_ALREADY_RUNNING` when another process holds it.
 * - `RunnerLock`: `ensureHeld` answers whether this process still holds the lock, taking it again
 *   if its connection was lost; `release` gives it up. The application never releases it: the lock
 *   goes with the process, so nothing it still runs is taken over while it runs.
 *
 * Recovery takes over the turns of every other runner id (`releaseOtherRunners`): that is right
 * only while no other live process works on the same database, which this lock guarantees.
 * PostgreSQL releases the lock itself when the holder's connection ends, so a killed process
 * never blocks the next one. A holder whose connection is cut (a database restart) takes the lock
 * again at once on a fresh connection — not from the pool, which may still hold connections cut
 * at the same moment; while the database is down that fails, and recovery tries every minute.
 */
import type { Client } from "pg";

import { AppError } from "../lib/app-error.js";

const RUNNER_LOCK_NAME = "osinara-agent-runtime";

export interface RunnerLock {
  ensureHeld(): Promise<boolean>;
  release(): Promise<void>;
}

/** Opens a new connection, outside any pool (`openDedicatedConnection`). */
export type LockConnection = () => Promise<Client>;

// Ending the connection drops the lock. A connection that is already broken holds nothing, so a
// failure to end it is only noted.
async function drop(client: Client): Promise<void> {
  try {
    await client.end();
  } catch (error) {
    console.warn(JSON.stringify({ code: "AGENT_RUNNER_LOCK_CONNECTION_END_FAILED", error: error instanceof Error ? error.message : String(error) }));
  }
}

async function tryLock(connect: LockConnection): Promise<Client | null> {
  const client = await connect();
  try {
    const row = (await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [RUNNER_LOCK_NAME],
    )).rows[0]!;
    if (row.locked) return client;
    await drop(client);
    return null;
  } catch (error) {
    await drop(client);
    throw error;
  }
}

export async function acquireRunnerLock(connect: LockConnection): Promise<RunnerLock> {
  let holder: Client | null = null;
  let released = false;
  // One attempt at a time: two attempts of this process would see each other as another holder.
  let retaking: Promise<boolean> | null = null;

  function hold(client: Client): void {
    holder = client;
    client.on("error", (error) => lost(client, error));
    client.on("end", () => lost(client, undefined));
  }

  function retake(): Promise<boolean> {
    retaking ??= (async () => {
      try {
        const client = await tryLock(connect);
        if (client === null) return false;
        if (released) {
          await drop(client);
          return false;
        }
        hold(client);
        console.info(JSON.stringify({ code: "AGENT_RUNNER_LOCK_RETAKEN" }));
        return true;
      } finally {
        retaking = null;
      }
    })();
    return retaking;
  }

  // The connection is gone, and the lock with it.
  function lost(client: Client, error: Error | undefined): void {
    if (holder !== client) return;
    holder = null;
    console.error(JSON.stringify({ code: "AGENT_RUNNER_LOCK_LOST", error: error?.message ?? "connection ended" }));
    void drop(client);
    // At once: until it is held again, a second process could start on this database.
    retake().catch((retakeError: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_RUNNER_LOCK_RETAKE_FAILED",
        error: retakeError instanceof Error ? retakeError.message : String(retakeError),
      }));
    });
  }

  const first = await tryLock(connect);
  if (first === null) {
    throw new AppError("AGENT_RUNTIME_ALREADY_RUNNING", "С этой базой уже работает другой процесс агента. Остановите его и запустите снова");
  }
  hold(first);

  return {
    async ensureHeld() {
      const current = holder;
      if (current !== null) {
        // A live session keeps its lock; a connection the server already cut fails this query.
        try {
          await current.query("SELECT 1");
          return true;
        } catch (error) {
          lost(current, error instanceof Error ? error : undefined);
        }
      }
      return await retake();
    },
    async release() {
      released = true;
      const client = holder;
      holder = null;
      if (client !== null) await drop(client);
    },
  };
}
