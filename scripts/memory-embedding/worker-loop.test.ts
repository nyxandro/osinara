/**
 * Embedding worker loop tests.
 *
 * Constructs covered:
 * - A database restart is a pause for the worker, not the end of the process.
 * - Anything the classifier does not call a database outage still ends the run.
 * - An outage is not a verdict on the memory: it must not become a terminal failure.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../agent/lib/app-error.js";
import { isTerminalJobFailure, runEmbeddingWorkerLoop } from "./worker-loop.js";

function databaseOutage(): Error {
  return new AppError(
    "AGENT_DATABASE_UNAVAILABLE",
    "Соединение с базой данных прервано. Обработка ожидает восстановления",
  );
}

function dependencies(overrides: Partial<Parameters<typeof runEmbeddingWorkerLoop>[0]> = {}) {
  return {
    isStopping: () => true,
    markAlive: vi.fn(async () => undefined),
    processBatch: vi.fn(async () => 0),
    sleep: vi.fn(async () => undefined),
    waitForDatabase: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("runEmbeddingWorkerLoop", () => {
  it("waits out a database restart and keeps working instead of dying", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let passes = 0;
    const deps = dependencies({
      isStopping: () => passes >= 2,
      processBatch: vi.fn(async () => {
        passes += 1;
        if (passes === 1) throw databaseOutage();
        return 0;
      }),
    });

    try {
      await expect(runEmbeddingWorkerLoop(deps)).resolves.toBeUndefined();

      expect(deps.waitForDatabase).toHaveBeenCalledTimes(1);
      expect(deps.processBatch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(info.mock.calls[0]![0] as string)).toMatchObject({
        code: "AGENT_MEMORY_EMBEDDING_WORKER_WAITING",
      });
    } finally { info.mockRestore(); }
  });

  it("ends the run on a failure that is not a database outage", async () => {
    const deps = dependencies({
      isStopping: () => false,
      processBatch: vi.fn(async () => { throw new AppError("AGENT_MEMORY_EMBEDDING_UNEXPECTED", "сломалось"); }),
    });

    await expect(runEmbeddingWorkerLoop(deps)).rejects.toThrowError(
      /AGENT_MEMORY_EMBEDDING_UNEXPECTED/u,
    );
    expect(deps.waitForDatabase).not.toHaveBeenCalled();
  });

  it("gives up when the database does not come back inside its budget", async () => {
    const deps = dependencies({
      isStopping: () => false,
      processBatch: vi.fn(async () => { throw databaseOutage(); }),
      waitForDatabase: vi.fn(async () => { throw databaseOutage(); }),
    });

    // The wait is bounded on purpose: past that the container restart is the right answer.
    await expect(runEmbeddingWorkerLoop(deps)).rejects.toThrowError(/AGENT_DATABASE_UNAVAILABLE/u);
  });

  it("does not spin when the probe passes but the work keeps failing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let passes = 0;
    // `SELECT 1` on an open pooled connection succeeds while a new connection is refused: with
    // `too many clients` the probe returns at once and the claim keeps failing.
    const deps = dependencies({
      isStopping: () => passes >= 3,
      processBatch: vi.fn(async () => { passes += 1; throw databaseOutage(); }),
    });

    try {
      await runEmbeddingWorkerLoop(deps);

      expect(deps.sleep).toHaveBeenCalledTimes(3);
      expect(deps.markAlive).toHaveBeenCalled();
      // One line on entering the wait, not one per turn of the loop.
      expect(info.mock.calls.length).toBe(1);
    } finally { info.mockRestore(); }
  });

  it("sleeps only when a pass found nothing to do", async () => {
    let passes = 0;
    const deps = dependencies({
      isStopping: () => passes >= 2,
      processBatch: vi.fn(async () => { passes += 1; return passes === 1 ? 3 : 0; }),
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
