/**
 * Successful model call observation tests.
 *
 * Constructs covered:
 * - `recordSuccessfulModelCall`: its commit does not wait for the disk, and it stays bounded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  config: undefined as unknown,
  connect: vi.fn(async () => {}),
  end: vi.fn(async () => {}),
  query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
}));

vi.mock("pg", () => ({
  Client: vi.fn(function (this: unknown, config: unknown) {
    client.config = config;
    return client;
  }),
}));

import { recordSuccessfulModelCall } from "./model-availability-repository.js";

const signal = {
  observedAt: new Date("2026-09-29T12:00:00Z"),
  requestId: "0b8f3f64-7c1a-4d5e-9f2a-3c4d5e6f7a8b",
  routeKey: "a".repeat(64),
};

describe("successful model call observation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("commits without waiting for the disk to confirm the write", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://osinara@postgres/osinara");

    await recordSuccessfulModelCall(signal);

    // The host disk occasionally takes over two seconds to confirm a synchronous write, even when
    // idle, and the answer waits for this observation: every such commit lost the mark (#311).
    // A crash can lose only the last fraction of a second of marks, and any later ordinary commit
    // that acts on one flushes it too, because the journal is written in order.
    const config = client.config as { options?: string; query_timeout?: number; statement_timeout?: number };
    expect(config.options).toBe("-c synchronous_commit=off");
    expect(config.query_timeout).toBe(2_000);
    expect(config.statement_timeout).toBe(2_000);
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
  });
});
