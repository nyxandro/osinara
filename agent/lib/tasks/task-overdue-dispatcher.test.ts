/**
 * Overdue task dispatcher tests.
 *
 * Constructs covered:
 * - Side-effect marker ordering and terminal Telegram delivery failure.
 */
import { describe, expect, it, vi } from "vitest";

import { createTaskOverdueDispatcher } from "./task-overdue-dispatcher.js";

const job = {
  id: "00000000-0000-4000-8000-000000000001",
  leaseToken: "00000000-0000-4000-8000-000000000002",
  messageThreadId: "42",
  telegramChatId: "-1001",
  title: "Забрать заказ",
};

describe("task overdue dispatcher", () => {
  it("marks before delivery and completes the lease", async () => {
    const order: string[] = [];
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      complete: vi.fn().mockImplementation(async () => { order.push("complete"); }),
      fail: vi.fn(),
      markDispatchStarted: vi.fn().mockImplementation(async () => { order.push("mark"); }),
    };
    const dispatch = createTaskOverdueDispatcher({
      deliver: vi.fn().mockImplementation(async () => { order.push("deliver"); }),
      repository,
    });
    await expect(dispatch(new Date("2026-07-13T04:00:00Z"))).resolves.toBe(1);
    expect(order).toEqual(["mark", "deliver", "complete"]);
  });

  it("records a terminal delivery error", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      complete: vi.fn(),
      fail: vi.fn(),
      markDispatchStarted: vi.fn(),
    };
    const dispatch = createTaskOverdueDispatcher({
      deliver: vi.fn().mockRejectedValue(new Error("network")),
      repository,
    });
    await dispatch(new Date("2026-07-13T04:00:00Z"));
    expect(repository.fail).toHaveBeenCalledWith(job, "AGENT_TASK_OVERDUE_DELIVERY_FAILED");
  });
});
