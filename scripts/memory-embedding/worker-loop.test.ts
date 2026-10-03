/**
 * Embedding worker loop tests.
 *
 * Constructs covered:
 * - A database restart is a pause for the worker, not the end of the process.
 * - Anything the classifier does not call a database outage still ends the run.
 * - A shutdown cancels the wait instead of sitting it out past the container grace period.
 * - An outage is not a verdict on the memory: it must not become a terminal failure.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../agent/lib/app-error.js";
import { MEMORY_EMBEDDING_WORKER_WAITING_CODE } from "../../agent/lib/memory-config.js";
import { isTerminalJobFailure, runEmbeddingWorkerLoop } from "./worker-loop.js";

/** Other modules log during a full run, so the line is found by its code, not by its position. */
function waitingLines(info: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return info.mock.calls
    .map((call) => { try { return JSON.parse(String(call[0])); } catch { return null; } })
    .filter((line): line is Record<string, unknown> =>
      line !== null && line.code === MEMORY_EMBEDDING_WORKER_WAITING_CODE);
}

function databaseOutage(): Error {
  return new AppError(
    "AGENT_DATABASE_UNAVAILABLE",
    "Соединение с базой данных прервано. Обработка ожидает восстановления",
  );
}

/** Stands in for the real wait: it returns when the database answers, or when the process stops. */
function waitHonouringSignal(resolves: boolean) {
  return vi.fn((signal: AbortSignal) => resolves
    ? Promise.resolve()
    : new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
}

function dependencies(overrides: Partial<Parameters<typeof runEmbeddingWorkerLoop>[0]> = {}) {
  return {
    markAlive: vi.fn(async () => undefined),
    processBatch: vi.fn(async () => 0),
    sleep: vi.fn(async () => undefined),
    stopSignal: AbortSignal.abort(),
    waitForDatabase: waitHonouringSignal(true),
    ...overrides,
  };
}

describe("runEmbeddingWorkerLoop", () => {
  it("waits out a database restart and keeps working instead of dying", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const stop = new AbortController();
    let passes = 0;
    const deps = dependencies({
      stopSignal: stop.signal,
      processBatch: vi.fn(async () => {
        passes += 1;
        if (passes >= 2) stop.abort();
        if (passes === 1) throw databaseOutage();
        return 0;
      }),
    });

    try {
      await expect(runEmbeddingWorkerLoop(deps)).resolves.toBeUndefined();

      expect(deps.waitForDatabase).toHaveBeenCalledTimes(1);
      expect(deps.processBatch).toHaveBeenCalledTimes(2);
      expect(waitingLines(info)).toHaveLength(1);
    } finally { info.mockRestore(); }
  });

  it("ends the run on a failure that is not a database outage", async () => {
    const deps = dependencies({
      stopSignal: new AbortController().signal,
      processBatch: vi.fn(async () => { throw new AppError("AGENT_MEMORY_EMBEDDING_UNEXPECTED", "сломалось"); }),
    });

    await expect(runEmbeddingWorkerLoop(deps)).rejects.toThrowError(
      /AGENT_MEMORY_EMBEDDING_UNEXPECTED/u,
    );
    expect(deps.waitForDatabase).not.toHaveBeenCalled();
  });

  it("gives up when the database does not come back inside its budget", async () => {
    const deps = dependencies({
      stopSignal: new AbortController().signal,
      processBatch: vi.fn(async () => { throw databaseOutage(); }),
      waitForDatabase: vi.fn(async () => { throw databaseOutage(); }),
    });

    // The wait is bounded on purpose: past that the container restart is the right answer.
    await expect(runEmbeddingWorkerLoop(deps)).rejects.toThrowError(/AGENT_DATABASE_UNAVAILABLE/u);
  });

  it("does not spin when the probe passes but the work keeps failing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const stop = new AbortController();
    let passes = 0;
    // `SELECT 1` on an open pooled connection succeeds while a new connection is refused: with
    // `too many clients` the probe returns at once and the claim keeps failing.
    const deps = dependencies({
      stopSignal: stop.signal,
      processBatch: vi.fn(async () => {
        passes += 1;
        if (passes >= 3) stop.abort();
        throw databaseOutage();
      }),
    });

    try {
      await runEmbeddingWorkerLoop(deps);

      expect(deps.sleep).toHaveBeenCalledTimes(3);
      expect(deps.markAlive).toHaveBeenCalled();
      // One line on entering the wait, not one per turn of the loop.
      expect(waitingLines(info)).toHaveLength(1);
    } finally { info.mockRestore(); }
  });

  it("stops without waiting out the database when the container is being shut down", async () => {
    // Docker gives this container ten seconds after SIGTERM; the wait budget is sixty. A wait that
    // is merely no longer awaited keeps its timer, and the process is killed instead of exiting.
    const stop = new AbortController();
    const deps = dependencies({
      stopSignal: stop.signal,
      processBatch: vi.fn(async () => { throw databaseOutage(); }),
      waitForDatabase: waitHonouringSignal(false),
    });

    const loop = runEmbeddingWorkerLoop(deps);
    await vi.waitFor(() => expect(deps.waitForDatabase).toHaveBeenCalled());
    stop.abort();

    await expect(loop).resolves.toBeUndefined();
    expect(deps.processBatch).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("sleeps only when a pass found nothing to do", async () => {
    const stop = new AbortController();
    let passes = 0;
    const deps = dependencies({
      stopSignal: stop.signal,
      processBatch: vi.fn(async () => {
        passes += 1;
        if (passes >= 2) stop.abort();
        return passes === 1 ? 3 : 0;
      }),
    });

    await runEmbeddingWorkerLoop(deps);

    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });
});

describe("isTerminalJobFailure", () => {
  it("does not blame the memory for an outage of the database", () => {
    expect(isTerminalJobFailure(databaseOutage())).toBe(false);
  });

  it("treats everything else as the job's own failure", () => {
    expect(isTerminalJobFailure(new AppError("AGENT_MEMORY_EMBEDDING_PROVIDER_FAILED", "сервис"))).toBe(true);
    expect(isTerminalJobFailure(new Error("что угодно"))).toBe(true);
  });
});
