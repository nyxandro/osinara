import { expect, it, vi } from "vitest";

import { runTelegramProcessing } from "./telegram-processing-deadline.js";
import { isDatabaseUnavailable, normalizePostgresError } from "./database-errors.js";
import { AppError } from "./app-error.js";

it("distinguishes a database socket reset from an unrelated external integration reset", () => {
  const external = Object.assign(new Error("socket reset"),{ code: "ECONNRESET" });
  expect(isDatabaseUnavailable(external)).toBe(false);
  const database = normalizePostgresError(external);
  expect(isDatabaseUnavailable(database)).toBe(true);
  expect(database).toMatchObject({ cause: external });
  expect(isDatabaseUnavailable(new Error("Client has encountered a connection error and is not queryable"))).toBe(true);
});

it("does not cancel a live Eve turn when the observation database disconnects", async () => {
  const cancel = vi.fn();
  const disconnected = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
  await expect(runTelegramProcessing({ timeoutMilliseconds: 100, cancellationMilliseconds: 20,
    readCursor: async () => 0, execute: async control => {
      control.observeSession({ id: "live", cancel, getEventStream: vi.fn() });
      throw disconnected;
    },
  })).rejects.toBe(disconnected);
  expect(cancel).not.toHaveBeenCalled();
});

it("does not cancel the execution after another observer takes over the expired lease", async () => {
  const cancel=vi.fn();
  const transferred=new AppError("AGENT_TELEGRAM_LEASE_LOST","Наблюдение передано другому обработчику");
  await expect(runTelegramProcessing({ timeoutMilliseconds: 100,cancellationMilliseconds: 20,readCursor: async () => 0,
    execute: async control => { control.observeSession({ id: "live",cancel,getEventStream: vi.fn() }); throw transferred; },
  })).rejects.toBe(transferred);
  expect(cancel).not.toHaveBeenCalled();
});

it("gives up waiting for the database the moment the process is asked to stop", async () => {
  // Docker gives a worker ten seconds after SIGTERM while this wait is allowed sixty. A wait that
  // only stops being awaited keeps its timer, and the process is killed instead of exiting.
  const { waitForApplicationDatabase } = await import("./database-recovery.js");
  const controller = new AbortController();
  controller.abort();

  await expect(waitForApplicationDatabase(controller.signal)).rejects.toThrowError(/abort/iu);
});
