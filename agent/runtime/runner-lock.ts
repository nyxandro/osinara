/**
 * One agent process per database: the PostgreSQL advisory lock the process holds while it runs.
 *
 * Export:
 * - `acquireRunnerLock`: takes the lock on a connection of its own, held for the process's
 *   lifetime, or fails with `AGENT_RUNTIME_ALREADY_RUNNING` when another process holds it. If the
 *   process lost the lock and another process took it meanwhile, `onTaken` is called once: the
 *   process must stop, or both would run the same turns.
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
 * The cut session itself may still hold the lock for a moment while it ends: that is told apart
 * from another process by the session's id, and waited out briefly.
 */
import { setTimeout as sleep } from "node:timers/promises";

import type { Client } from "pg";

import { AppError } from "../lib/app-error.js";

const RUNNER_LOCK_NAME = "osinara-agent-runtime";
// How long a cut session of this process may take to end before its lock counts as still pending.
const ENDING_SESSION_CHECKS = 10;
const ENDING_SESSION_PAUSE_MILLISECONDS = 200;

export interface RunnerLock {
  ensureHeld(): Promise<boolean>;
  release(): Promise<void>;
}

/** Opens a new connection, outside any pool (`openDedicatedConnection`). */
export type LockConnection = () => Promise<Client>;

type Attempt =
  | { readonly client: Client; readonly sessionPid: number }
  | { readonly holderPid: number | null };

// Ending the connection drops the lock. A connection that is already broken holds nothing, so a
// failure to end it is only noted.
async function drop(client: Client): Promise<void> {
  try {
    await client.end();
  } catch (error) {
    console.warn(JSON.stringify({ code: "AGENT_RUNNER_LOCK_CONNECTION_END_FAILED", error: error instanceof Error ? error.message : String(error) }));
  }
}

async function tryLock(connect: LockConnection): Promise<Attempt> {
  const client = await connect();
  try {
    const row = (await client.query<{ locked: boolean; pid: number }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked, pg_backend_pid() AS pid", [RUNNER_LOCK_NAME],
    )).rows[0]!;
    if (row.locked) return { client, sessionPid: row.pid };
    // A bigint advisory key shows its high half as classid and its low half as objid.
    const holder = (await client.query<{ pid: number }>(
      `SELECT l.pid FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.classid::bigint = ((hashtextextended($1, 0) >> 32) & 4294967295)
          AND l.objid::bigint = (hashtextextended($1, 0) & 4294967295)`,
      [RUNNER_LOCK_NAME],
    )).rows[0];
    await drop(client);
    return { holderPid: holder?.pid ?? null };
  } catch (error) {
    await drop(client);
    throw error;
  }
}

export async function acquireRunnerLock(connect: LockConnection, onTaken: () => void): Promise<RunnerLock> {
  let holder: Client | null = null;
  // The database session that held the lock for this process last.
  let sessionPid: number | null = null;
  let released = false;
  let taken = false;
  // One attempt at a time: two attempts of this process would see each other as another holder.
  let retaking: Promise<boolean> | null = null;

  function hold(attempt: { readonly client: Client; readonly sessionPid: number }): void {
    holder = attempt.client;
    sessionPid = attempt.sessionPid;
    attempt.client.on("error", (error) => lost(attempt.client, error));
    attempt.client.on("end", () => lost(attempt.client, undefined));
  }

  async function takeAgain(): Promise<boolean> {
    for (let check = 1; ; check += 1) {
      const attempt = await tryLock(connect);
      if ("client" in attempt) {
        if (released) {
          await drop(attempt.client);
          return false;
        }
        hold(attempt);
        console.info(JSON.stringify({ code: "AGENT_RUNNER_LOCK_RETAKEN" }));
        return true;
      }
      // Free again by the time it was looked up, or still held by this process's ending session.
      const ending = attempt.holderPid === null || attempt.holderPid === sessionPid;
      if (ending && check < ENDING_SESSION_CHECKS) {
        await sleep(ENDING_SESSION_PAUSE_MILLISECONDS);
        continue;
      }
      if (ending) {
        console.error(JSON.stringify({ code: "AGENT_RUNNER_LOCK_RELEASE_PENDING", sessionPid }));
        return false;
      }
      if (!taken && !released) {
        taken = true;
        console.error(JSON.stringify({ code: "AGENT_RUNTIME_SECOND_PROCESS", holderPid: attempt.holderPid }));
        onTaken();
      }
      return false;
    }
  }

  function retake(): Promise<boolean> {
    retaking ??= takeAgain().finally(() => { retaking = null; });
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
  if (!("client" in first)) {
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
