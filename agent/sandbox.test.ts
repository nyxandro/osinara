/**
 * Session sandbox opening tests.
 *
 * Constructs covered:
 * - The first open stores the session's mounts; a later open restores the same container identity.
 * - Background memory review gets a sandbox without workspace mounts and without compute.
 */
import { describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./lib/sandbox-runner/runner-sandbox-backend.js", () => ({ openRunnerSandbox: runner.open }));
const workspaces = vi.hoisted(() => ({ mounts: vi.fn() }));
vi.mock("./lib/workspaces/workspace-repository.js", () => ({ workspaceRepository: workspaces }));

import { createSessionSandboxes } from "./sandbox.js";

const REVIEW_AUTH = {
  current: {
    attributes: { memoryReviewMode: "background", sandboxSessionId: "00000000-0000-4000-8000-000000000070" },
    authenticator: "memory-review",
    principalId: "00000000-0000-4000-8000-000000000030",
    principalType: "user",
  },
  initiator: null,
};

function database(stored: Record<string, unknown> | null) {
  const writes: unknown[] = [];
  return {
    writes,
    query: vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith("SELECT")) return { rowCount: 1, rows: [{ sandbox_state: stored }] };
      writes.push(JSON.parse(values[1] as string));
      return { rowCount: 1, rows: [] };
    }),
  };
}

describe("session sandbox", () => {
  it("opens a memory review sandbox without mounts and stores that once", async () => {
    const captured = { disabled: true, mounts: [], sandboxSessionId: "00000000-0000-4000-8000-000000000070", version: 3 };
    runner.open.mockReturnValue({ captureState: () => captured, session: { id: "s" } });
    const db = database(null);

    await createSessionSandboxes({ database: db as never })({ auth: REVIEW_AUTH as never, id: "wrun_01M3YNFXVX5WCP17ZVB8ZTMQAR" });

    expect(runner.open).toHaveBeenCalledWith(expect.objectContaining({
      stored: null, use: { mounts: [], sandboxSessionId: "00000000-0000-4000-8000-000000000070" },
    }));
    expect(workspaces.mounts).not.toHaveBeenCalled();
    expect(db.writes).toEqual([captured]);
  });

  it("restores a stored sandbox and writes nothing new", async () => {
    const stored = { disabled: true, mounts: [], sandboxSessionId: "00000000-0000-4000-8000-000000000070", version: 3 };
    runner.open.mockReturnValue({ captureState: () => stored, session: { id: "s" } });
    const db = database(stored);

    await createSessionSandboxes({ database: db as never })({ auth: REVIEW_AUTH as never, id: "wrun_01M3YNFXVX5WCP17ZVB8ZTMQAR" });

    expect(runner.open).toHaveBeenLastCalledWith(expect.objectContaining({ stored }));
    expect(db.writes).toEqual([]);
  });
});
