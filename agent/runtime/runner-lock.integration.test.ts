/**
 * One agent process per database.
 *
 * Constructs covered:
 * - A second process cannot take the lock while the first holds it, and gets a clear error.
 * - A holder whose connection is cut takes the lock again at once, so a second process still
 *   cannot start; if the database refused it meanwhile and another process got the lock, the
 *   first one learns that it is no longer the holder and is told once, so it can stop.
 * - The process's own session that took the lock while the answer to that was lost is not taken
 *   for another process: the process waits for it instead of stopping.
 * - A released lock is free for the next process at once.
 */
import type { Client } from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { closeDatabase, database, openDedicatedConnection } from "../lib/database.js";
import { acquireRunnerLock, sessionPidOf, type LockConnection, type RunnerLock } from "./runner-lock.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");

// The lock is a database session's, so two "processes" are just two acquisitions.
const held: RunnerLock[] = [];

const NOT_TAKEN = () => { throw new Error("TEST_LOCK_TAKEN_UNEXPECTEDLY"); };

async function acquire(connect: LockConnection = openDedicatedConnection, onTaken: () => void = NOT_TAKEN): Promise<RunnerLock> {
  const lock = await acquireRunnerLock(connect, onTaken);
  held.push(lock);
  return lock;
}

async function lockHolders(): Promise<number[]> {
  return (await database().query<{ pid: number }>(
    "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()",
  )).rows.map((row) => row.pid);
}

async function until(probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await probe()) {
    if (Date.now() > deadline) throw new Error("TEST_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cutHolder(): Promise<void> {
  const [pid] = await lockHolders();
  if (pid === undefined) throw new Error("TEST_LOCK_HOLDER_MISSING");
  await database().query("SELECT pg_terminate_backend($1)", [pid]);
  await until(async () => !(await lockHolders()).includes(pid));
}

(enabled ? describe : describe.skip)("runner lock", () => {
  afterEach(async () => {
    for (const lock of held.splice(0)) await lock.release();
  });
  afterAll(closeDatabase);

  it("refuses a second process while the first one holds the lock", async () => {
    const first = await acquire();

    await expect(acquireRunnerLock(openDedicatedConnection, NOT_TAKEN)).rejects.toThrow("AGENT_RUNTIME_ALREADY_RUNNING");
    expect(await first.ensureHeld()).toBe(true);
  });

  it("takes the lock again at once when its connection is cut", async () => {
    const first = await acquire();

    await cutHolder();
    await until(async () => (await lockHolders()).length === 1);

    await expect(acquireRunnerLock(openDedicatedConnection, NOT_TAKEN)).rejects.toThrow("AGENT_RUNTIME_ALREADY_RUNNING");
    expect(await first.ensureHeld()).toBe(true);
  });

  it("learns that another process holds the lock after the database refused it a new connection, and says so once", async () => {
    let databaseDown = false;
    let taken = 0;
    const first = await acquire(async () => {
      if (databaseDown) throw new Error("TEST_DATABASE_DOWN");
      return await openDedicatedConnection();
    }, () => { taken += 1; });
    databaseDown = true;
    await cutHolder();

    const second = await acquire();
    databaseDown = false;
    expect(await first.ensureHeld()).toBe(false);
    expect(await first.ensureHeld()).toBe(false);
    expect(taken).toBe(1);
    expect(await second.ensureHeld()).toBe(true);

    await second.release();
    expect(await first.ensureHeld()).toBe(true);
    await expect(acquireRunnerLock(openDedicatedConnection, NOT_TAKEN)).rejects.toThrow("AGENT_RUNTIME_ALREADY_RUNNING");
  });

  it("does not take its own session for another process when the answer to its lock attempt was lost", async () => {
    const clients: Client[] = [];
    const realEnds: Array<() => Promise<void>> = [];
    let taken = 0;
    const first = await acquire(async () => {
      const client = await openDedicatedConnection();
      clients.push(client);
      realEnds.push(client.end.bind(client));
      if (clients.length === 2) {
        // The database takes the lock for this session, but the answer never reaches the process,
        // and the session outlives the process's attempt to close it.
        const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
        client.query = (async (text: string, values?: unknown[]) => {
          const result = await query(text, values);
          if (text.includes("pg_try_advisory_lock")) throw new Error("TEST_ANSWER_LOST");
          return result;
        }) as unknown as typeof client.query;
        client.end = (async () => {}) as typeof client.end;
      }
      return client;
    }, () => { taken += 1; });
    try {
      await realEnds[0]!();
      await until(async () => clients.length === 2 && (await lockHolders()).includes(sessionPidOf(clients[1]!)));

      expect(await first.ensureHeld()).toBe(false);
      expect(taken).toBe(0);
      await realEnds[1]!();
      expect(await first.ensureHeld()).toBe(true);
      expect(taken).toBe(0);
    } finally {
      // A failed check must not leave the stalled session holding the lock for the next tests.
      await Promise.all(realEnds.slice(0, 2).map(async (end) => await end()));
    }
  });

  it("frees the lock for the next process as soon as it is released", async () => {
    const first = await acquire();
    await first.release();

    const next = await acquire();
    expect(await next.ensureHeld()).toBe(true);
  });
});
