/**
 * PostgreSQL Workflow session retention adapter tests.
 *
 * Tests:
 * - Rejects malformed and absent Eve run identities.
 * - Refuses active runs and retained hooks.
 * - Deletes every public per-run table atomically before the run row.
 * - Rolls back and preserves the original database failure.
 */
import { describe, expect, it, vi } from "vitest";

import { deletePostgresEveSession } from "./workflow-postgres-session-storage.js";

const runId = "wrun_01M0AZKZAKTGSH4QQZBBCJK63C";

function clientWithRows(rows: Array<Record<string, unknown>[]>) {
  const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
    rowCount: 1,
    rows: rows.shift() ?? [],
  }));
  return { query };
}

describe("deletePostgresEveSession", () => {
  it("rejects a malformed run id before querying PostgreSQL", async () => {
    const client = clientWithRows([]);

    await expect(deletePostgresEveSession("session-1", client)).rejects.toThrowError(
      /AGENT_EVE_SESSION_ID_INVALID/u,
    );
    expect(client.query).not.toHaveBeenCalled();
  });

  it("deletes a run left non-terminal long past any live execution", async () => {
    // The status guard protects a live scenario; a run with no activity for a day is not one.
    const abandoned = clientWithRows([
      [], [{ abandoned: true, status: "running" }],
      [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [],
    ]);

    await expect(deletePostgresEveSession(runId, abandoned)).resolves.toBeUndefined();

    expect(abandoned.query).toHaveBeenLastCalledWith("COMMIT");
    // Activity is the run's own event stream: `updated_at` barely moves after a run starts.
    const statusQuery = abandoned.query.mock.calls[1]![0] as string;
    expect(statusQuery).toMatch(/workflow_events/u);
    expect(statusQuery).toMatch(/abandoned/u);
  });

  it("takes the hooks of an abandoned run with it instead of parking the session", async () => {
    // Workflow drops hooks when a run reaches a terminal status; on production not one completed
    // run holds any, while every stuck one does. Keeping them would park the session for good.
    const abandoned = clientWithRows([
      [], [{ abandoned: true, status: "running" }],
      [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [],
    ]);

    await expect(deletePostgresEveSession(runId, abandoned)).resolves.toBeUndefined();

    const statements = abandoned.query.mock.calls.map((call) => call[0] as string);
    expect(statements).toContain("DELETE FROM workflow.workflow_hooks WHERE run_id = $1");
    expect(statements.some((text) => /SELECT EXISTS/u.test(text))).toBe(false);
  });

  it("requires an existing terminal run without retained hooks", async () => {
    const missing = clientWithRows([[], []]);
    await expect(deletePostgresEveSession(runId, missing)).rejects.toThrowError(
      /AGENT_EVE_SESSION_STORAGE_MISSING/u,
    );
    expect(missing.query).toHaveBeenLastCalledWith("ROLLBACK");

    const active = clientWithRows([[], [{ status: "running" }], []]);
    await expect(deletePostgresEveSession(runId, active)).rejects.toThrowError(
      /AGENT_EVE_SESSION_STORAGE_ACTIVE/u,
    );
    expect(active.query).toHaveBeenLastCalledWith("ROLLBACK");

    const retainedHook = clientWithRows([[], [{ status: "completed" }], [{ exists: true }], []]);
    await expect(deletePostgresEveSession(runId, retainedHook)).rejects.toThrowError(
      /AGENT_EVE_SESSION_HOOK_RETENTION_ACTIVE/u,
    );
    expect(retainedHook.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("deletes all public per-run records in one transaction", async () => {
    const client = clientWithRows([[], [{ status: "failed" }], [{ exists: false }]]);

    await expect(deletePostgresEveSession(runId, client)).resolves.toBeUndefined();

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("FROM workflow.workflow_runs"),
      expect.stringContaining("FROM workflow.workflow_hooks"),
      "DELETE FROM workflow.workflow_stream_chunks WHERE run_id = $1",
      "DELETE FROM workflow.workflow_waits WHERE run_id = $1",
      "DELETE FROM workflow.workflow_hooks WHERE run_id = $1",
      "DELETE FROM workflow.workflow_steps WHERE run_id = $1",
      "DELETE FROM workflow.workflow_events WHERE run_id = $1",
      "DELETE FROM workflow.workflow_event_slots WHERE run_id = $1",
      "DELETE FROM workflow.workflow_runs WHERE id = $1",
      "COMMIT",
    ]);
  });

  it("rolls back and rethrows the original deletion error", async () => {
    const databaseError = new Error("connection lost");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "cancelled" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: false }] })
      .mockRejectedValueOnce(databaseError)
      .mockResolvedValueOnce({ rowCount: null, rows: [] });

    await expect(deletePostgresEveSession(runId, { query })).rejects.toBe(databaseError);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});
