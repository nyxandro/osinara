/** Maintenance admission keeps callbacks available while ordinary work drains. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ phase: "ready", query: vi.fn() }));
vi.mock("./database.js", () => ({ database: () => ({ query: storage.query }) }));
import { withRuntimeAdmission } from "./runtime-maintenance.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost/test");
  storage.phase = "ready";
  storage.query.mockImplementation(async (sql: string, values: unknown[]) => ({
    rows: sql.includes("config.phase") ? [{ phase: storage.phase, id: values[0] }] : [],
  }));
});

describe("runtime maintenance admission", () => {
  it.each(["draining", "frozen"])("does not start new background work when %s", async (phase) => {
    storage.phase = phase;
    const work = vi.fn();
    expect(await withRuntimeAdmission("ordinary", work)).toBeNull();
    expect(work).not.toHaveBeenCalled();
    expect(storage.query).toHaveBeenCalledTimes(1);
  });
  it("allows an approval to finish existing work during draining", async () => {
    storage.phase = "draining";
    expect(await withRuntimeAdmission("callback", async () => 42)).toBe(42);
  });
  it("blocks callbacks at the final frozen boundary", async () => {
    storage.phase = "frozen";
    const work = vi.fn();
    expect(await withRuntimeAdmission("callback", work)).toBeNull();
    expect(work).not.toHaveBeenCalled();
  });
  it("does not invent a ready state when the maintenance record is missing", async () => {
    storage.query.mockResolvedValue({ rows: [] });
    await expect(withRuntimeAdmission("ordinary", vi.fn())).rejects.toThrow("AGENT_RUNTIME_MAINTENANCE_MISSING");
  });
  it("holds admission until work finishes and cleans up on failure", async () => {
    const error = new Error("work failed");
    await expect(withRuntimeAdmission("ordinary", async () => { throw error; })).rejects.toBe(error);
    expect(storage.query.mock.calls[1]?.[0]).toContain("DELETE FROM runtime_admission_holders");
  });
  it("preserves work and cleanup errors instead of hiding an admission holder", async () => {
    const workError = new Error("work failed"), cleanupError = new Error("database unavailable");
    storage.query.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.startsWith("DELETE")) throw cleanupError;
      return { rows: [{ phase: "ready", id: values[0] }] };
    });
    await expect(withRuntimeAdmission("ordinary", async () => { throw workError; }))
      .rejects.toMatchObject({ errors: [workError, cleanupError] });
  });
});
