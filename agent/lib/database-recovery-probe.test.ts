/**
 * Database recovery probe tests.
 *
 * Constructs covered:
 * - The probe carries its own read timeout, shorter than the grace period a worker is given to stop.
 * - A probe that timed out means the database is still not answering, not a reason to give up.
 */
import { afterEach, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./database.js", () => ({ database: () => ({ query }) }));

import { waitForApplicationDatabase } from "./database-recovery.js";

// Docker gives a container ten seconds after SIGTERM unless its service says otherwise.
const DOCKER_DEFAULT_STOP_MILLISECONDS = 10_000;

afterEach(() => { query.mockReset(); });

it("bounds each probe below the grace period a worker has to stop in", async () => {
  query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

  await waitForApplicationDatabase();

  const [config] = query.mock.calls[0]!;
  expect(config).toMatchObject({ text: "SELECT 1" });
  expect((config as { query_timeout: number }).query_timeout).toBeGreaterThan(0);
  expect((config as { query_timeout: number }).query_timeout).toBeLessThan(DOCKER_DEFAULT_STOP_MILLISECONDS);
});

it("keeps waiting when a probe times out instead of treating it as a verdict", async () => {
  // node-postgres reports its own read timeout as a plain Error with this exact message.
  query
    .mockRejectedValueOnce(new Error("Query read timeout"))
    .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

  await expect(waitForApplicationDatabase()).resolves.toBeUndefined();
  expect(query).toHaveBeenCalledTimes(2);
});
