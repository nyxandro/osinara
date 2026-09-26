/**
 * Application database pool configuration tests.
 *
 * Constructs covered:
 * - `database`: keeps warm connections, so a quiet pause does not require a new PostgreSQL process.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const createApplicationDatabasePool = vi.hoisted(() => vi.fn(() => ({ end: vi.fn(async () => {}) })));

vi.mock("./database-client.js", () => ({ createApplicationDatabasePool }));

import { closeDatabase, database } from "./database.js";

describe("application database pool", () => {
  afterEach(async () => {
    await closeDatabase();
    vi.unstubAllEnvs();
    createApplicationDatabasePool.mockClear();
  });

  it("keeps idle connections open instead of reconnecting after every pause", () => {
    vi.stubEnv("DATABASE_URL", "postgres://osinara@postgres/osinara");

    database();

    // Under memory pressure PostgreSQL could not start a backend within the connect timeout,
    // while already open connections kept working (#285).
    const [config] = createApplicationDatabasePool.mock.calls[0] as unknown as [{
      connectionTimeoutMillis: number; max: number; min: number;
    }];
    expect(config.min).toBeGreaterThan(0);
    expect(config.min).toBeLessThanOrEqual(config.max);
    expect(config.connectionTimeoutMillis).toBe(5_000);
  });
});
