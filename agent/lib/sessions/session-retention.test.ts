/**
 * Eve terminal session retention job tests.
 *
 * Constructs covered:
 * - A dedicated PostgreSQL advisory lock serializes physical Workflow graph deletion.
 * - A concurrent invocation exits without claiming a second application session.
 * - Destroying the lock connection releases the session-level lock after the sweep.
 * - One session that refuses deletion does not cancel the sweep of the others.
 * - A run already gone from Workflow storage lets the application row go too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const values = vi.hoisted(() => {
  let lockHeld = false;
  let resolveDeletion!: () => void;
  const deletionPromise = new Promise<void>((resolve) => {
    resolveDeletion = resolve;
  });
  const lockRelease = vi.fn((destroy?: boolean) => {
    if (destroy) lockHeld = false;
  });
  const lockQuery = vi.fn(async () => {
    if (lockHeld) return { rows: [{ acquired: false }] };
    lockHeld = true;
    return { rows: [{ acquired: true }] };
  });
  return {
    deletionPromise,
    claimExpiredForDeletion: vi.fn(),
    completeDeletion: vi.fn(),
    connect: vi.fn(async () => ({ query: lockQuery, release: lockRelease })),
    deletePostgresEveSession: vi.fn(async () => deletionPromise),
    failDeletion: vi.fn(),
    lockQuery,
    lockRelease,
    resolveDeletion,
    retireAbandonedTasks: vi.fn(),
  };
});

vi.mock("../database.js", () => ({
  database: () => ({ connect: values.connect }),
}));
vi.mock("./workflow-postgres-session-storage.js", () => ({
  deleteConfiguredPostgresEveSession: values.deletePostgresEveSession,
}));
vi.mock("./session-repository.js", () => ({
  sessionRepository: {
    claimExpiredForDeletion: values.claimExpiredForDeletion,
    completeDeletion: values.completeDeletion,
    failDeletion: values.failDeletion,
    retireAbandonedTasks: values.retireAbandonedTasks,
  },
}));

import { AppError } from "../app-error.js";
import { deleteExpiredSessions } from "./session-retention.js";

describe("deleteExpiredSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Each test picks its own deletion behaviour; the shared default stays a pending deletion.
    values.deletePostgresEveSession.mockImplementation(async () => values.deletionPromise);
    values.claimExpiredForDeletion
      .mockResolvedValueOnce({
        eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QR",
        id: "application-session-1",
        leaseToken: "lease-1",
      })
      .mockResolvedValue(null);
  });

  it("serializes physical deletion across concurrent retention jobs", async () => {
    const first = deleteExpiredSessions();
    await vi.waitFor(() => expect(values.deletePostgresEveSession).toHaveBeenCalledTimes(1));

    await expect(deleteExpiredSessions()).resolves.toBe(0);
    expect(values.claimExpiredForDeletion).toHaveBeenCalledTimes(1);
    expect(values.lockRelease).toHaveBeenCalledWith(false);

    values.resolveDeletion();
    await expect(first).resolves.toBe(1);
    expect(values.completeDeletion).toHaveBeenCalledWith(
      "application-session-1",
      "lease-1",
    );
    expect(values.lockRelease).toHaveBeenLastCalledWith(true);
  });

  it("keeps sweeping when a lease is lost under a session", async () => {
    values.claimExpiredForDeletion.mockReset();
    values.claimExpiredForDeletion
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QR", id: "lost", leaseToken: "lease-1" })
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QS", id: "healthy", leaseToken: "lease-2" })
      .mockResolvedValue(null);
    values.deletePostgresEveSession.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    values.completeDeletion
      .mockRejectedValueOnce(new AppError("AGENT_SESSION_RETENTION_LEASE_LOST", "аренда потеряна"))
      .mockResolvedValueOnce(undefined);

    // Losing a lease is the very failure this sweep exists to survive: another worker took the row.
    await expect(deleteExpiredSessions()).resolves.toBe(1);

    // The row belongs to that other worker now; recording a failure on it is not ours to do.
    expect(values.failDeletion).not.toHaveBeenCalled();
  });

  it("keeps sweeping the rest of the queue when one session refuses deletion", async () => {
    values.claimExpiredForDeletion.mockReset();
    values.claimExpiredForDeletion
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QR", id: "stuck", leaseToken: "lease-1" })
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QS", id: "healthy", leaseToken: "lease-2" })
      .mockResolvedValue(null);
    values.deletePostgresEveSession
      .mockRejectedValueOnce(new AppError("AGENT_EVE_SESSION_STORAGE_ACTIVE", "ещё выполняется"))
      .mockResolvedValueOnce(undefined);

    await expect(deleteExpiredSessions()).resolves.toBe(1);

    expect(values.failDeletion).toHaveBeenCalledWith(
      "stuck", "lease-1", "AGENT_EVE_SESSION_STORAGE_ACTIVE", expect.any(Date),
    );
    expect(values.completeDeletion).toHaveBeenCalledWith("healthy", "lease-2");
  });

  it("lets the application row go when Workflow storage no longer holds the run", async () => {
    values.claimExpiredForDeletion.mockReset();
    values.claimExpiredForDeletion
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QR", id: "orphan", leaseToken: "lease-1" })
      .mockResolvedValue(null);
    values.deletePostgresEveSession
      .mockRejectedValueOnce(new AppError("AGENT_EVE_SESSION_STORAGE_MISSING", "не найдены данные"));

    await expect(deleteExpiredSessions()).resolves.toBe(1);

    expect(values.completeDeletion).toHaveBeenCalledWith("orphan", "lease-1");
    expect(values.failDeletion).not.toHaveBeenCalled();
  });
});
