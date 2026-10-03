/**
 * Session retention job tests.
 *
 * Constructs covered:
 * - An expired retired session is deleted; its runtime data goes with the row.
 * - A lost lease under one session does not stop the sweep, and records nothing on that row.
 * - One session that refuses deletion is parked and the sweep goes on with the others.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const values = vi.hoisted(() => ({
  claimExpiredForDeletion: vi.fn(),
  completeDeletion: vi.fn(),
  failDeletion: vi.fn(),
  retireAbandonedTasks: vi.fn(),
}));

vi.mock("./session-repository.js", () => ({
  sessionRepository: values,
}));

import { AppError } from "../app-error.js";
import { deleteExpiredSessions } from "./session-retention.js";

describe("deleteExpiredSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("deletes each expired session after retiring abandoned tasks", async () => {
    values.claimExpiredForDeletion
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QR", id: "application-session-1", leaseToken: "lease-1" })
      .mockResolvedValueOnce({ eveSessionId: null, id: "application-session-2", leaseToken: "lease-2" })
      .mockResolvedValue(null);

    await expect(deleteExpiredSessions()).resolves.toBe(2);

    expect(values.retireAbandonedTasks.mock.invocationCallOrder[0]).toBeLessThan(values.claimExpiredForDeletion.mock.invocationCallOrder[0]!);
    expect(values.completeDeletion.mock.calls).toEqual([["application-session-1", "lease-1"], ["application-session-2", "lease-2"]]);
  });

  it("keeps sweeping when a lease is lost under a session", async () => {
    values.claimExpiredForDeletion
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QR", id: "lost", leaseToken: "lease-1" })
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QS", id: "healthy", leaseToken: "lease-2" })
      .mockResolvedValue(null);
    values.completeDeletion
      .mockRejectedValueOnce(new AppError("AGENT_SESSION_RETENTION_LEASE_LOST", "аренда потеряна"))
      .mockResolvedValueOnce(undefined);

    await expect(deleteExpiredSessions()).resolves.toBe(1);

    expect(values.failDeletion).not.toHaveBeenCalled();
  });

  it("parks a session that refuses deletion and keeps sweeping the others", async () => {
    values.claimExpiredForDeletion
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QR", id: "stuck", leaseToken: "lease-1" })
      .mockResolvedValueOnce({ eveSessionId: "wrun_01KXB392VJ8YY13JMJ9YZAF5QS", id: "healthy", leaseToken: "lease-2" })
      .mockResolvedValue(null);
    values.completeDeletion
      .mockRejectedValueOnce(new AppError("AGENT_DATABASE_CONSTRAINT", "связанные данные"))
      .mockResolvedValueOnce(undefined);

    await expect(deleteExpiredSessions()).resolves.toBe(1);

    expect(values.failDeletion).toHaveBeenCalledWith("stuck", "lease-1", "AGENT_DATABASE_CONSTRAINT", expect.any(Date));
    expect(values.completeDeletion).toHaveBeenCalledWith("healthy", "lease-2");
  });
});
