/**
 * Reminder dispatcher orchestration tests.
 *
 * Constructs covered:
 * - Side-effect marker precedes Telegram delivery and successful completion.
 * - Delivery failures become terminal records without hidden retry.
 * - Timeline failures cannot reclassify a confirmed delivery as failed.
 * - A reminder of a disconnected group passes without delivery: nothing is sent, nothing fails (#465).
 */
import { describe, expect, it, vi } from "vitest";

import type { ClaimedReminder } from "./reminder-dispatch-repository.js";
import { createReminderDispatcher } from "./reminder-dispatcher.js";

const job: ClaimedReminder = {
  addresseeTelegramUserId: "101",
  authorRole: "owner",
  authorUserId: "00000000-0000-4000-8000-000000000003",
  buttons: null,
  familyId: "00000000-0000-4000-8000-000000000010",
  forumTopicId: null,
  content: "Позвонить врачу",
  delayed: false,
  dueAt: "2026-07-13T06:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000001",
  leaseToken: "00000000-0000-4000-8000-000000000002",
  mention: null,
  messageThreadId: null,
  groupId: null,
  ownerUserId: "00000000-0000-4000-8000-000000000011",
  scope: "personal",
  telegramChatId: "101",
  telegramChatType: "private",
  timezone: "Europe/Moscow",
};

describe("reminder dispatcher", () => {
  it("marks dispatch before delivery and completes the exact lease", async () => {
    const order: string[] = [];
    const groupJob = { ...job, groupId: "00000000-0000-4000-8000-000000000012" };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([groupJob]),
      complete: vi.fn().mockImplementation(async () => { order.push("complete"); }),
      fail: vi.fn(),
      markDispatchStarted: vi.fn().mockImplementation(async () => { order.push("mark"); }),
      skipWhileGroupDisconnected: vi.fn(),
    };
    const receipt = { messageId: "55", text: "Напоминание:\n\nПозвонить врачу" };
    const timeline = { recordAgentResponse: vi.fn().mockImplementation(async () => {
      order.push("timeline");
    }) };
    const deliver = vi.fn().mockImplementation(async () => {
      order.push("deliver");
      return receipt;
    });
    const dispatch = createReminderDispatcher({ deliver, isGroupDisconnected: async () => false, repository, timeline });

    await expect(dispatch(new Date("2026-07-13T06:00:00.000Z"))).resolves.toBe(1);
    expect(order).toEqual(["mark", "deliver", "complete", "timeline"]);
    expect(repository.complete).toHaveBeenCalledWith(groupJob, expect.any(Date), receipt);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("records one terminal failure when Telegram delivery fails", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      complete: vi.fn(),
      fail: vi.fn(),
      markDispatchStarted: vi.fn(),
      skipWhileGroupDisconnected: vi.fn(),
    };
    const dispatch = createReminderDispatcher({
      isGroupDisconnected: async () => false,
      deliver: vi.fn().mockRejectedValue(new Error("network unavailable")),
      repository,
      timeline: { recordAgentResponse: vi.fn() },
    });

    await expect(dispatch(new Date("2026-07-13T06:00:00.000Z"))).resolves.toBe(1);
    expect(repository.fail).toHaveBeenCalledWith(job, "AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED");
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("does not fail or redeliver a reminder when timeline persistence fails after completion", async () => {
    const groupJob = { ...job, groupId: "00000000-0000-4000-8000-000000000012" };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([groupJob]),
      complete: vi.fn(),
      fail: vi.fn(),
      markDispatchStarted: vi.fn(),
      skipWhileGroupDisconnected: vi.fn(),
    };
    const dispatch = createReminderDispatcher({
      isGroupDisconnected: async () => false,
      deliver: vi.fn().mockResolvedValue({ messageId: "55", text: "Напоминание" }),
      repository,
      timeline: { recordAgentResponse: vi.fn().mockRejectedValue(new Error("timeline unavailable")) },
    });

    await expect(dispatch(new Date("2026-07-13T06:00:00.000Z")))
      .rejects.toThrowError("timeline unavailable");
    expect(repository.complete).toHaveBeenCalledOnce();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("passes a reminder of a disconnected group without sending or failing it", async () => {
    const groupJob = { ...job, groupId: "00000000-0000-4000-8000-000000000012", scope: "group" as const, telegramChatId: "-1001" };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([groupJob]),
      complete: vi.fn(),
      fail: vi.fn(),
      markDispatchStarted: vi.fn(),
      skipWhileGroupDisconnected: vi.fn(),
    };
    const deliver = vi.fn();
    const isGroupDisconnected = vi.fn(async () => true);
    const dispatch = createReminderDispatcher({ deliver, isGroupDisconnected, repository, timeline: { recordAgentResponse: vi.fn() } });
    const now = new Date("2026-07-13T06:00:00.000Z");

    await expect(dispatch(now)).resolves.toBe(1);

    expect(isGroupDisconnected).toHaveBeenCalledWith(groupJob.groupId);
    expect(repository.skipWhileGroupDisconnected).toHaveBeenCalledWith(groupJob, now);
    expect(repository.markDispatchStarted).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("goes on with the batch when skipping one reminder fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const groupJob = { ...job, groupId: "00000000-0000-4000-8000-000000000012", id: "00000000-0000-4000-8000-000000000021" };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([groupJob, job]),
      complete: vi.fn(),
      fail: vi.fn(),
      markDispatchStarted: vi.fn(),
      skipWhileGroupDisconnected: vi.fn().mockRejectedValue(new Error("database unavailable")),
    };
    const deliver = vi.fn().mockResolvedValue({ messageId: "55", text: "Напоминание" });
    const dispatch = createReminderDispatcher({
      deliver, isGroupDisconnected: async (groupId) => groupId === groupJob.groupId, repository, timeline: { recordAgentResponse: vi.fn() },
    });

    await expect(dispatch(new Date("2026-07-13T06:00:00.000Z"))).resolves.toBe(2);

    expect(deliver).toHaveBeenCalledWith(job);
    expect(repository.fail).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("AGENT_REMINDER_SKIP_FAILED"));
    errors.mockRestore();
  });
});

