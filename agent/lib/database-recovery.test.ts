import { expect, it } from "vitest";

import { isDatabaseUnavailable, normalizePostgresError } from "./database-errors.js";

it("distinguishes a database socket reset from an unrelated external integration reset", () => {
  const external = Object.assign(new Error("socket reset"),{ code: "ECONNRESET" });
  expect(isDatabaseUnavailable(external)).toBe(false);
  const database = normalizePostgresError(external);
  expect(isDatabaseUnavailable(database)).toBe(true);
  expect(database).toMatchObject({ cause: external });
  expect(isDatabaseUnavailable(new Error("Client has encountered a connection error and is not queryable"))).toBe(true);
});

it("gives up waiting for the database the moment the process is asked to stop", async () => {
  // Docker gives a worker ten seconds after SIGTERM while this wait is allowed sixty. A wait that
  // only stops being awaited keeps its timer, and the process is killed instead of exiting.
  const { waitForApplicationDatabase } = await import("./database-recovery.js");
  const controller = new AbortController();
  controller.abort();

  await expect(waitForApplicationDatabase(controller.signal)).rejects.toThrowError(/abort/iu);
});
