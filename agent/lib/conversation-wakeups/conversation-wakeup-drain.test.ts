/**
 * Chat-queue wake-up processor tests.
 *
 * Constructs covered:
 * - A wake-up is claimed only with a model-turn slot already free, and the slot is always released.
 * - A fresh wake-up creates its turn, runs it to the end and only then closes the item.
 * - A wake-up reclaimed after its turn was created lets that turn finish and never creates another.
 * - A hand-off taken by the previous version, with no turn here, fails instead of being sent again.
 * - Preparation that withdraws or defers the wake-up starts no turn.
 * - A conversation without a session parks the schedule.
 * - A failing turn run leaves the run to that turn's own completion and fails only the item.
 * - A lost lease is left to the processor that reclaimed the item.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { createConversationWakeupProcessor, type ConversationWakeupDrainDependencies } from "./conversation-wakeup-drain.js";
import type { PreparedConversationWakeup } from "./conversation-wakeup-preparation.js";
import type { ConversationWakeupClaim } from "./conversation-wakeup-repository.js";
import { WAKEUP_SESSION_INACTIVE_CODE } from "./conversation-wakeup-turn-start.js";

const claim: ConversationWakeupClaim = {
  attemptCount: 1, dispatch: null, agentTurnId: null, id: "wakeup-1", leaseToken: "lease-1",
  queueId: "queue-1", runId: "run-1", scheduleId: "schedule-1",
};

const handoff = {
  admissionDeadlineAt: new Date(Date.now() + 60_000), agentSessionId: "wrun_session",
  id: "00000000-0000-4000-8000-00000000d001", turnId: "turn_created",
};

const wakeup = {
  applicationConversationId: "conversation-1", applicationSessionId: "app-session-1", authorUserId: "user-1",
  completedRuns: 0, agentSessionId: "wrun_session", familyId: "family-1", forumTopicId: null, groupId: null,
  maxRuns: 3, messageThreadId: null, role: "owner", runId: "run-1", sandboxSessionId: "thread-1",
  scenarioPrompt: "Проверь заказ", scheduledFor: new Date("2026-09-25T10:00:00Z"), scheduleId: "schedule-1",
  scope: "personal", skillAllowlist: [], telegramChatId: "101", telegramChatType: "private", telegramUserId: "101",
  timezone: "UTC", title: "Заказ", userRequest: "Скажи, когда привезут",
} satisfies PreparedConversationWakeup;

let dependencies: ConversationWakeupDrainDependencies & {
  createTurn: ReturnType<typeof vi.fn>;
  repository: { [K in keyof ConversationWakeupDrainDependencies["repository"]]: ReturnType<typeof vi.fn> };
  runTurn: ReturnType<typeof vi.fn>;
  slots: { release: ReturnType<typeof vi.fn>; tryAcquire: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  dependencies = {
    createTurn: vi.fn(async () => "turn_new"),
    leaseMilliseconds: 60_000,
    repository: {
      claimNext: vi.fn(async () => claim),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      prepare: vi.fn(async () => ({ kind: "ready", wakeup })),
      renewLease: vi.fn(async () => undefined),
      withdrawNotStarted: vi.fn(async () => true),
    },
    runTurn: vi.fn(async () => ({ status: "completed", text: "Привезли" })),
    slots: { release: vi.fn(), tryAcquire: vi.fn(() => "slot") },
  } as never;
});

describe("createConversationWakeupProcessor", () => {
  it("claims nothing while every model-turn slot is busy", async () => {
    dependencies.slots.tryAcquire.mockReturnValue(undefined);

    expect(await createConversationWakeupProcessor(dependencies)()).toBe(false);
    expect(dependencies.repository.claimNext).not.toHaveBeenCalled();
    expect(dependencies.slots.release).not.toHaveBeenCalled();
  });

  it("returns the slot when no wake-up is due", async () => {
    dependencies.repository.claimNext.mockResolvedValue(null);

    expect(await createConversationWakeupProcessor(dependencies)()).toBe(false);
    expect(dependencies.slots.release).toHaveBeenCalledTimes(1);
  });

  it("creates its turn, runs it to the end and only then closes the item", async () => {
    const order: string[] = [];
    dependencies.runTurn.mockImplementation(async () => { order.push("turn"); return { status: "completed", text: null }; });
    dependencies.repository.complete.mockImplementation(async () => { order.push("complete"); });

    expect(await createConversationWakeupProcessor(dependencies)()).toBe(true);

    expect(dependencies.createTurn).toHaveBeenCalledWith(claim, wakeup);
    expect(dependencies.runTurn).toHaveBeenCalledWith("turn_new");
    expect(order).toEqual(["turn", "complete"]);
    expect(dependencies.repository.complete).toHaveBeenCalledWith(claim, "wrun_session");
    expect(dependencies.slots.release).toHaveBeenCalledTimes(1);
  });

  it("lets the turn of a reclaimed wake-up finish and never creates another", async () => {
    dependencies.repository.claimNext.mockResolvedValue({ ...claim, dispatch: handoff });

    await createConversationWakeupProcessor(dependencies)();

    expect(dependencies.createTurn).not.toHaveBeenCalled();
    expect(dependencies.repository.prepare).not.toHaveBeenCalled();
    expect(dependencies.runTurn).toHaveBeenCalledWith("turn_created");
    expect(dependencies.repository.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "wakeup-1" }), "wrun_session");
  });

  it("fails a hand-off the previous version took instead of sending it again", async () => {
    dependencies.repository.claimNext.mockResolvedValue({ ...claim, dispatch: { ...handoff, turnId: null } });

    await createConversationWakeupProcessor(dependencies)();

    expect(dependencies.createTurn).not.toHaveBeenCalled();
    expect(dependencies.runTurn).not.toHaveBeenCalled();
    expect(dependencies.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wakeup-1" }),
      expect.objectContaining({ code: "AGENT_CONVERSATION_WAKEUP_HANDOFF_UNRECOVERABLE" }),
    );
  });

  it.each([{ kind: "withdrawn" }, { kind: "deferred" }])("starts no turn when preparation is $kind", async (outcome) => {
    dependencies.repository.prepare.mockResolvedValue(outcome);

    await createConversationWakeupProcessor(dependencies)();

    expect(dependencies.createTurn).not.toHaveBeenCalled();
    expect(dependencies.repository.fail).not.toHaveBeenCalled();
  });

  it("parks the schedule when the conversation has no session to continue", async () => {
    dependencies.createTurn.mockRejectedValue(new AppError(WAKEUP_SESSION_INACTIVE_CODE, "Разговор пробуждения больше не ведётся"));

    await createConversationWakeupProcessor(dependencies)();

    expect(dependencies.repository.withdrawNotStarted).toHaveBeenCalledWith(claim, "AGENT_SCHEDULE_CONVERSATION_CHANGED");
    expect(dependencies.repository.fail).not.toHaveBeenCalled();
  });

  it("fails only the item when running its turn fails, leaving the run to the turn", async () => {
    dependencies.runTurn.mockRejectedValue(new Error("handler failed after the outcome"));

    await createConversationWakeupProcessor(dependencies)();

    expect(dependencies.repository.fail).toHaveBeenCalledWith(claim, expect.objectContaining({ code: "AGENT_CONVERSATION_WAKEUP_FAILED" }));
    expect(dependencies.repository.complete).not.toHaveBeenCalled();
    expect(dependencies.slots.release).toHaveBeenCalledTimes(1);
  });

  it("leaves a reclaimed item to the processor that owns it now", async () => {
    dependencies.createTurn.mockRejectedValue(
      new AppError("AGENT_TELEGRAM_LEASE_LOST", "Срок обработки пробуждения в очереди чата истёк"),
    );

    expect(await createConversationWakeupProcessor(dependencies)()).toBe(true);
    expect(dependencies.repository.fail).not.toHaveBeenCalled();
    expect(dependencies.runTurn).not.toHaveBeenCalled();
  });
});
