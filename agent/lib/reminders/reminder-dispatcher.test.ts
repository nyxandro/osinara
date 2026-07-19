/**
 * Reminder dispatcher orchestration tests.
 *
 * Constructs covered:
 * - Side-effect marker precedes Telegram delivery and successful completion.
 * - Delivery failures become terminal records without hidden retry.
 */
import { describe, expect, it, vi } from "vitest";

import type { ClaimedReminder } from "./reminder-dispatch-repository.js";
import { createReminderDispatcher } from "./reminder-dispatcher.js";

const job: ClaimedReminder = {
  familyId: "00000000-0000-4000-8000-000000000010",
  content: "Позвонить врачу",
  delayed: false,
  dueAt: "2026-07-13T06:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000001",
  leaseToken: "00000000-0000-4000-8000-000000000002",
  messageThreadId: null,
  groupId: null,
  ownerUserId: "00000000-0000-4000-8000-000000000011",
  scope: "personal",
  telegramChatId: "101",
  timezone: "Europe/Moscow",
};

describe("reminder dispatcher", () => {
  it("marks dispatch before delivery and completes the exact lease", async () => {
    const order: string[] = [];
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      complete: vi.fn().mockImplementation(async () => { order.push("complete"); }),
      fail: vi.fn(),
      markDispatchStarted: vi.fn().mockImplementation(async () => { order.push("mark"); }),
    };
    const receipt = { messageId: "55", text: "Напоминание:\n\nПозвонить врачу" };
    const deliver = vi.fn().mockImplementation(async () => {
      order.push("deliver");
      return receipt;
    });
    const dispatch = createReminderDispatcher({ deliver, repository });

    await expect(dispatch(new Date("2026-07-13T06:00:00.000Z"))).resolves.toBe(1);
    expect(order).toEqual(["mark", "deliver", "complete"]);
    expect(repository.complete).toHaveBeenCalledWith(job, expect.any(Date), receipt);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("records one terminal failure when Telegram delivery fails", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      complete: vi.fn(),
      fail: vi.fn(),
      markDispatchStarted: vi.fn(),
    };
    const dispatch = createReminderDispatcher({
      deliver: vi.fn().mockRejectedValue(new Error("network unavailable")),
      repository,
    });

    await expect(dispatch(new Date("2026-07-13T06:00:00.000Z"))).resolves.toBe(1);
    expect(repository.fail).toHaveBeenCalledWith(job, "AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED");
    expect(repository.complete).not.toHaveBeenCalled();
  });
});
