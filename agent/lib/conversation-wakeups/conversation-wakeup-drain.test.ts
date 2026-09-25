/**
 * Chat-queue wake-up processor tests.
 *
 * Constructs covered:
 * - A wake-up is claimed only with a model-turn slot already free, and the slot is always released.
 * - A fresh wake-up fixes its dispatch before the handoff, marks its turn with that dispatch and its
 *   admission deadline, and closes the item at its own turn's boundary, ignoring other events.
 * - A wake-up reclaimed after its handoff is observed from its stored start and never sent again.
 *   Without an admitted turn it is observed only until its admission deadline, then parked unless a
 *   turn was admitted meanwhile.
 * - Preparation that withdraws or defers the wake-up starts no turn.
 * - A refused handoff, or a session Eve no longer runs, parks the schedule.
 * - A lost observer cancels its turn and leaves the run to that turn's own completion.
 * - A lost lease is left to the processor that reclaimed the item.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { createConversationWakeupProcessor, type ConversationWakeupDrainDependencies } from "./conversation-wakeup-drain.js";
import type { PreparedConversationWakeup } from "./conversation-wakeup-preparation.js";
import type { ConversationWakeupClaim } from "./conversation-wakeup-repository.js";

const claim: ConversationWakeupClaim = {
  attemptCount: 1, dispatch: null, eveTurnId: null, id: "wakeup-1", leaseToken: "lease-1",
  queueId: "queue-1", runId: "run-1", scheduleId: "schedule-1",
};

const handoff = {
  admissionDeadlineAt: new Date(Date.now() + 60_000), eveSessionId: "ses_eve_1",
  id: "00000000-0000-4000-8000-00000000d001", startIndex: 12,
};
const expiredHandoff = { ...handoff, admissionDeadlineAt: new Date(Date.now() - 60 * 60_000) };

const wakeup = {
  applicationConversationId: "conversation-1", applicationSessionId: "app-session-1", authorUserId: "user-1",
  completedRuns: 0, eveSessionId: "ses_eve_1", familyId: "family-1", forumTopicId: null, groupId: null,
  maxRuns: 3, messageThreadId: null, role: "owner", runId: "run-1", sandboxSessionId: "thread-1",
  scenarioPrompt: "Проверь заказ", scheduledFor: new Date("2026-09-25T10:00:00Z"), scheduleId: "schedule-1",
  scope: "personal", skillAllowlist: [], telegramChatId: "101", telegramChatType: "private", telegramUserId: "101",
  timezone: "UTC", title: "Заказ", userRequest: "Скажи, когда привезут",
} satisfies PreparedConversationWakeup;

type Event = { data?: Record<string, unknown>; type: string };

function stream(events: Event[]) {
  return new ReadableStream<Event>({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}

function turnEvents(dispatchId: string, turnId = "turn_4"): Event[] {
  const data = { osinaraTelegramIngressId: dispatchId, turnId };
  return [
    { data, type: "turn.started" },
    { data, type: "turn.completed" },
    { data: { osinaraTelegramIngressId: dispatchId }, type: "session.waiting" },
  ];
}

let session: {
  cancel: ReturnType<typeof vi.fn>;
  getEventStream: ReturnType<typeof vi.fn>;
  id: string;
  send: ReturnType<typeof vi.fn>;
};
let dependencies: ConversationWakeupDrainDependencies & {
  repository: { [K in keyof ConversationWakeupDrainDependencies["repository"]]: ReturnType<typeof vi.fn> };
  slots: { release: ReturnType<typeof vi.fn>; tryAcquire: ReturnType<typeof vi.fn> };
};

function freshDispatchId(): string {
  return dependencies.repository.markDispatched.mock.calls[0]![2].id;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  session = {
    cancel: vi.fn(async () => ({ sessionId: "ses_eve_1", status: "accepted" })),
    getEventStream: vi.fn(async () => stream(turnEvents(freshDispatchId()))),
    id: "ses_eve_1",
    send: vi.fn(async () => ({ sessionId: "ses_eve_1", status: "accepted" })),
  };
  dependencies = {
    admissionMilliseconds: 60_000,
    attachSession: vi.fn(() => session),
    cancellationMilliseconds: 1_000,
    leaseMilliseconds: 60_000,
    now: () => new Date("2026-09-25T10:00:30Z"),
    observerIdleMilliseconds: 5_000,
    readCursor: vi.fn(async () => 40),
    repository: {
      admittedTurn: vi.fn(async () => ({ eveTurnId: null, open: true })),
      claimNext: vi.fn(async () => claim),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      markDispatched: vi.fn(async () => 40),
      prepare: vi.fn(async () => ({ kind: "ready", wakeup })),
      renewLease: vi.fn(async () => undefined),
      withdrawNotStarted: vi.fn(async () => true),
    },
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

  it("marks the turn with its dispatch and closes the item at that turn's boundary", async () => {
    session.getEventStream.mockImplementation(async () => stream([
      // Another dispatch's boundary must not close this wake-up.
      { data: { osinaraTelegramIngressId: "other-dispatch" }, type: "session.waiting" },
      ...turnEvents(freshDispatchId()),
    ]));

    expect(await createConversationWakeupProcessor(dependencies)()).toBe(true);

    const [, , dispatch] = dependencies.repository.markDispatched.mock.calls[0]!;
    expect(dependencies.repository.markDispatched).toHaveBeenCalledWith(claim, "ses_eve_1", {
      admissionDeadlineAt: expect.any(Date), id: expect.any(String),
    });
    const [message, options] = session.send.mock.calls[0]!;
    expect(message).toContain("<conversation_wakeup>");
    expect(options).toMatchObject({
      auth: { attributes: {
        conversationScheduleRunId: "run-1",
        osinaraTelegramDeadlineAt: dispatch.admissionDeadlineAt.toISOString(),
        osinaraTelegramIngressId: dispatch.id,
      } },
      turnPolicy: "queue",
    });
    expect(session.getEventStream).toHaveBeenCalledWith({ startIndex: 40 });
    expect(dependencies.repository.complete).toHaveBeenCalledWith(claim, "ses_eve_1", 44);
    expect(dependencies.slots.release).toHaveBeenCalledTimes(1);
  });

  it("observes a reclaimed handed-off wake-up from its start and never sends it again", async () => {
    dependencies.repository.claimNext.mockResolvedValue({ ...claim, dispatch: handoff, eveTurnId: "turn_4" });
    session.getEventStream.mockImplementation(async () => stream(turnEvents(handoff.id)));

    await createConversationWakeupProcessor(dependencies)();

    expect(session.send).not.toHaveBeenCalled();
    expect(dependencies.repository.prepare).not.toHaveBeenCalled();
    expect(session.getEventStream).toHaveBeenCalledWith({ startIndex: 12 });
    expect(dependencies.repository.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "wakeup-1" }), "ses_eve_1", 15);
  });

  it("parks a reclaimed wake-up whose turn did not start by its admission deadline", async () => {
    dependencies.repository.claimNext.mockResolvedValue({ ...claim, dispatch: expiredHandoff });

    await createConversationWakeupProcessor(dependencies)();

    expect(dependencies.repository.withdrawNotStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wakeup-1" }),
      "AGENT_CONVERSATION_WAKEUP_NOT_STARTED",
    );
    expect(session.getEventStream).not.toHaveBeenCalled();
    expect(dependencies.repository.fail).not.toHaveBeenCalled();
  });

  it("closes a reclaimed wake-up whose turn finished before its admission deadline", async () => {
    dependencies.repository.claimNext.mockResolvedValue({ ...claim, dispatch: handoff });
    session.getEventStream.mockImplementation(async () => stream([
      { data: { osinaraTelegramIngressId: "other-dispatch" }, type: "session.waiting" },
      ...turnEvents(handoff.id),
    ]));

    await createConversationWakeupProcessor(dependencies)();

    expect(session.getEventStream).toHaveBeenCalledWith({ startIndex: 12 });
    expect(dependencies.repository.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "wakeup-1" }), "ses_eve_1", 16);
    expect(dependencies.repository.withdrawNotStarted).not.toHaveBeenCalled();
  });

  it("stops waiting for the admission deadline as soon as its lease is lost", async () => {
    dependencies.repository.claimNext.mockResolvedValue({ ...claim, dispatch: handoff });
    session.getEventStream.mockImplementation(async () => new ReadableStream({ start: () => undefined }));
    dependencies.repository.renewLease.mockRejectedValue(
      new AppError("AGENT_TELEGRAM_LEASE_LOST", "Срок обработки пробуждения в очереди чата истёк"),
    );
    dependencies.leaseMilliseconds = 30;

    expect(await createConversationWakeupProcessor(dependencies)()).toBe(true);
    expect(dependencies.repository.withdrawNotStarted).not.toHaveBeenCalled();
    expect(dependencies.repository.fail).not.toHaveBeenCalled();
    expect(dependencies.slots.release).toHaveBeenCalledTimes(1);
  });

  it("observes the turn admitted while the expired handoff was being parked", async () => {
    dependencies.repository.claimNext.mockResolvedValue({ ...claim, dispatch: expiredHandoff });
    dependencies.repository.withdrawNotStarted.mockResolvedValue(false);
    dependencies.repository.admittedTurn.mockResolvedValue({ eveTurnId: "turn_4", open: true });
    session.getEventStream.mockImplementation(async () => stream(turnEvents(handoff.id)));

    await createConversationWakeupProcessor(dependencies)();

    expect(dependencies.repository.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "wakeup-1" }), "ses_eve_1", 15);
  });

  it.each([{ kind: "withdrawn" }, { kind: "deferred" }])("starts no turn when preparation is $kind", async (outcome) => {
    dependencies.repository.prepare.mockResolvedValue(outcome);

    await createConversationWakeupProcessor(dependencies)();

    expect(session.send).not.toHaveBeenCalled();
    expect(dependencies.repository.markDispatched).not.toHaveBeenCalled();
    expect(dependencies.repository.fail).not.toHaveBeenCalled();
  });

  it("parks the schedule when Eve refuses the handoff", async () => {
    session.send.mockRejectedValue(new Error("workflow unavailable"));

    await createConversationWakeupProcessor(dependencies)();

    expect(dependencies.repository.withdrawNotStarted).toHaveBeenCalledWith(claim, "AGENT_CONVERSATION_WAKEUP_HANDOFF_FAILED");
    expect(dependencies.repository.fail).not.toHaveBeenCalled();
    expect(dependencies.repository.complete).not.toHaveBeenCalled();
  });

  it("parks the schedule when Eve no longer runs the conversation", async () => {
    session.send.mockResolvedValue({ status: "session_not_active" });

    await createConversationWakeupProcessor(dependencies)();

    expect(dependencies.repository.withdrawNotStarted).toHaveBeenCalledWith(claim, "AGENT_SCHEDULE_CONVERSATION_CHANGED");
    expect(dependencies.repository.fail).not.toHaveBeenCalled();
  });

  it("cancels its turn when the observer loses it and leaves the run to that turn", async () => {
    let reads = 0;
    session.getEventStream.mockImplementation(async () => {
      reads += 1;
      const [started, , waiting] = turnEvents(freshDispatchId());
      // The first read ends without a boundary; the cancellation read then confirms one.
      return stream(reads === 1 ? [started!] : [waiting!]);
    });

    await createConversationWakeupProcessor(dependencies)();

    expect(session.cancel).toHaveBeenCalledWith({ turnId: "turn_4" });
    expect(dependencies.repository.fail).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ code: "AGENT_TELEGRAM_PROCESSING_INTERRUPTED" }),
    );
    expect(dependencies.repository.complete).not.toHaveBeenCalled();
    expect(dependencies.slots.release).toHaveBeenCalledTimes(1);
  });

  it("leaves a reclaimed item to the processor that owns it now", async () => {
    dependencies.repository.markDispatched.mockRejectedValue(
      new AppError("AGENT_TELEGRAM_LEASE_LOST", "Срок обработки пробуждения в очереди чата истёк"),
    );

    expect(await createConversationWakeupProcessor(dependencies)()).toBe(true);
    expect(dependencies.repository.fail).not.toHaveBeenCalled();
    expect(session.send).not.toHaveBeenCalled();
  });
});
