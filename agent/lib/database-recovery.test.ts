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

// pg-pool 3.14 raises both as plain errors without a code before any query reaches the server (#559):
// the first when no connection is handed out in time, the second when a new one does not open in time.
it.each(["timeout exceeded when trying to connect", "Connection terminated due to connection timeout"])(
  "treats the pool's '%s' as the database being out of reach, so callers wait instead of failing",
  (message) => {
    const pool = new Error(message);
    expect(isDatabaseUnavailable(pool)).toBe(true);
    expect(normalizePostgresError(pool)).toMatchObject({ code: "AGENT_DATABASE_UNAVAILABLE", cause: pool });
  },
);

it("gives up waiting for the database the moment the process is asked to stop", async () => {
  // Docker gives a worker ten seconds after SIGTERM while this wait is allowed sixty. A wait that
  // only stops being awaited keeps its timer, and the process is killed instead of exiting.
  const { waitForApplicationDatabase } = await import("./database-recovery.js");
  const controller = new AbortController();
  controller.abort();

  await expect(waitForApplicationDatabase(controller.signal)).rejects.toThrowError(/abort/iu);
});
