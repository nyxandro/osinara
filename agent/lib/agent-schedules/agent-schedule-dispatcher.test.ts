/**
 * Agent schedule dispatcher unit tests.
 *
 * Constructs covered:
 * - `createAgentScheduleDispatcher`: hands an isolated target to the runtime's channel source.
 * - A failed claimed job, including failed session cleanup, cannot block the remaining batch.
 * - The run prompt names the runtime's exact empty-delivery marker, so a scenario can skip an empty report.
 * - A conversation occurrence is handed to its chat queue and never starts a session here.
 */
import { describe, expect, it, vi } from "vitest";

import { EMPTY_DELIVERY_MARKER } from "../../runtime/turn/step-history.js";
import { createAgentScheduleDispatcher } from "./agent-schedule-dispatcher.js";
import type { ClaimedAgentSchedule } from "./agent-schedule-dispatch-repository.js";

const job: ClaimedAgentSchedule = {
  completedRuns: 0,
  executionContext: "isolated",
  maxRuns: null,
  authorUserId: "user-1",
  capabilityAllowlist: [],
  familyId: "family-1",
  forumTopicId: null,
  groupId: null,
  historyWindowDays: null,
  id: "schedule-1",
  leaseToken: "lease-1",
  messageThreadId: null,
  nextRunAt: "2026-07-17T06:00:00.000Z",
  recurrenceKind: "daily",
  role: "owner",
  runId: "run-1",
  scenarioPrompt: "Собери короткую сводку новостей по ИИ.",
  scope: "personal",
  telegramChatId: "101",
  telegramChatType: "private",
  telegramUserId: "telegram-101",
  timezone: "Europe/Moscow",
  title: "Новости ИИ",
  userRequest: "Каждое утро присылай новости по ИИ",
};

describe("agent schedule dispatcher", () => {
  it("starts a scheduled Telegram session with isolated run auth", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn(),
      markRunning: vi.fn(),
    };
    const prepareSession = vi.fn().mockResolvedValue({
      continuationToken: "101::schedule:run-1",
      generation: 0,
      id: "app-session-1",
      rotated: false,
      sandboxSessionId: "sandbox-1",
    });
    const startInChat = vi.fn().mockResolvedValue({ sessionId: "agent-session-1" });

    const dispatched = await createAgentScheduleDispatcher({
      discardSession: vi.fn(), enqueueConversation: vi.fn(),
      prepareHistory: vi.fn(),
      prepareSession,
      repository,
      startInChat,
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(dispatched).toBe(1);
    expect(startInChat.mock.calls[0]![1]).toContain("scheduled_for_local: 2026-07-17 09:00:00 Europe/Moscow");
    // Silence is expressed only by this exact marker; any other wording is delivered as a message.
    expect(startInChat.mock.calls[0]![1]).toContain(EMPTY_DELIVERY_MARKER);
    expect(prepareSession).toHaveBeenCalledWith(job, "101::schedule:run-1", new Date("2026-07-17T06:00:00.000Z"));
    expect(startInChat).toHaveBeenCalledWith({
      chatId: "101",
      conversationId: "schedule:run-1",
    }, expect.stringContaining("<scheduled_agent_run>"), {
      auth: expect.objectContaining({
        attributes: expect.objectContaining({
          applicationSessionId: "app-session-1",
          memoryScopes: ["personal", "family"],
          scheduleScheduledFor: "2026-07-17T06:00:00.000Z",
          scheduleTitle: "Новости ИИ",
          scheduledRunId: "run-1",
          telegramActorId: "telegram-101",
          telegramActorKind: "telegram_user",
        }),
        authenticator: "telegram",
        principalId: "user-1",
      }),
    });
    expect(repository.markDispatchStarted).toHaveBeenCalledWith(job, {
      applicationSessionId: "app-session-1",
    });
    expect(repository.markRunning).toHaveBeenCalledWith(job, {
      applicationSessionId: "app-session-1",
      agentSessionId: "agent-session-1",
    });
  });

  it("prepares history before handing an external group run to an isolated external session", async () => {
    const groupJob = {
      ...job,
      capabilityAllowlist: ["send_workspace_file"],
      groupId: "group-1",
      historyWindowDays: 7,
      scope: "group",
      telegramChatId: "-1001234567890",
      telegramChatType: "supergroup",
    } as never;
    const repository = {
      claimDue: vi.fn().mockResolvedValue([groupJob]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn(),
      markRunning: vi.fn(),
    };
    const prepareHistory = vi.fn().mockResolvedValue({ chunkCount: 2, entryCount: 75 });
    const prepareSession = vi.fn().mockResolvedValue({
      continuationToken: "-1001234567890::schedule:run-1",
      generation: 0,
      id: "group-session-1",
      rotated: false,
      sandboxSessionId: "group-sandbox-1",
    });
    const startInChat = vi.fn().mockResolvedValue({ sessionId: "group-agent-session-1" });

    await createAgentScheduleDispatcher({
      discardSession: vi.fn(), enqueueConversation: vi.fn(),
      prepareHistory,
      prepareSession,
      repository,
      startInChat,
    } as never)(new Date("2026-07-17T06:00:00.000Z"));

    expect(prepareHistory).toHaveBeenCalledWith(groupJob);
    expect(prepareHistory.mock.invocationCallOrder[0]).toBeLessThan(repository.markDispatchStarted.mock.invocationCallOrder[0]!);
    expect(prepareSession.mock.invocationCallOrder[0]).toBeLessThan(repository.markDispatchStarted.mock.invocationCallOrder[0]!);
    expect(startInChat).toHaveBeenCalledWith({
      chatId: "-1001234567890",
      conversationId: "schedule:run-1",
    }, expect.any(String), {
      auth: expect.objectContaining({
        attributes: expect.objectContaining({
          groupId: "group-1",
          groupType: "external",
          memoryScopes: ["group"],
          scheduledGroupHistory: "enabled",
          toolAllowlist: ["send_workspace_file"],
        }),
      }),
    });
  });

  it("retires a prepared session when live authorization rejects the pre-handoff transition", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn().mockResolvedValue(false),
      markRunning: vi.fn(),
    };
    const discardSession = vi.fn();
    const startInChat = vi.fn();

    await createAgentScheduleDispatcher({
      discardSession,
      enqueueConversation: vi.fn(),
      prepareHistory: vi.fn(),
      prepareSession: vi.fn().mockResolvedValue({
        continuationToken: "101::schedule:run-1",
        generation: 0,
        id: "revoked-session-1",
        rotated: false,
        sandboxSessionId: "revoked-sandbox-1",
      }),
      repository,
      startInChat,
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(discardSession).toHaveBeenCalledWith("revoked-session-1");
    expect(startInChat).not.toHaveBeenCalled();
    expect(repository.markRunning).not.toHaveBeenCalled();
  });

  it("retires a prepared session when the handoff fails before a session can run", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn().mockResolvedValue(true),
      markRunning: vi.fn(),
    };
    const discardSession = vi.fn();

    await createAgentScheduleDispatcher({
      discardSession,
      enqueueConversation: vi.fn(),
      prepareHistory: vi.fn(),
      prepareSession: vi.fn().mockResolvedValue({
        continuationToken: "101::schedule:run-1",
        generation: 0,
        id: "failed-handoff-session-1",
        rotated: false,
        sandboxSessionId: "failed-handoff-sandbox-1",
      }),
      repository,
      startInChat: vi.fn().mockRejectedValue(new Error("handoff failed")),
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(repository.failClaim).toHaveBeenCalledWith(job, "AGENT_SCHEDULE_HANDOFF_FAILED");
    expect(discardSession).toHaveBeenCalledWith("failed-handoff-session-1");
    expect(repository.markRunning).not.toHaveBeenCalled();
  });

  it("continues the claimed batch when one dispatch marker fails", async () => {
    const secondJob = {
      ...job,
      id: "schedule-2",
      leaseToken: "lease-2",
      runId: "run-2",
    };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job, secondJob]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn().mockRejectedValueOnce(new Error("marker unavailable")).mockResolvedValueOnce(true),
      markRunning: vi.fn(),
    };
    const startInChat = vi.fn().mockResolvedValue({ sessionId: "agent-session-2" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const dispatched = await createAgentScheduleDispatcher({
      discardSession: vi.fn(), enqueueConversation: vi.fn(),
      prepareHistory: vi.fn(),
      prepareSession: vi.fn().mockImplementation(async (claimedJob: ClaimedAgentSchedule) => ({
        continuationToken: `101::schedule:${claimedJob.runId}`,
        generation: 0,
        id: `app-${claimedJob.runId}`,
        rotated: false,
        sandboxSessionId: `sandbox-${claimedJob.runId}`,
      })),
      repository,
      startInChat,
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(dispatched).toBe(2);
    expect(startInChat).toHaveBeenCalledTimes(1);
    expect(repository.markRunning).toHaveBeenCalledWith(secondJob, {
      applicationSessionId: "app-run-2",
      agentSessionId: "agent-session-2",
    });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("AGENT_SCHEDULE_DISPATCH_FAILED"));
    consoleError.mockRestore();
  });

  it("continues the claimed batch when rejected authorization cleanup fails", async () => {
    const secondJob = {
      ...job,
      id: "schedule-2",
      leaseToken: "lease-2",
      runId: "run-2",
    };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job, secondJob]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      markRunning: vi.fn(),
    };
    const discardSession = vi.fn().mockRejectedValueOnce(new Error("cleanup unavailable"));
    const startInChat = vi.fn().mockResolvedValue({ sessionId: "agent-session-2" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createAgentScheduleDispatcher({
      discardSession,
      enqueueConversation: vi.fn(),
      prepareHistory: vi.fn(),
      prepareSession: vi.fn().mockImplementation(async (claimedJob: ClaimedAgentSchedule) => ({
        continuationToken: `101::schedule:${claimedJob.runId}`,
        generation: 0,
        id: `app-${claimedJob.runId}`,
        rotated: false,
        sandboxSessionId: `sandbox-${claimedJob.runId}`,
      })),
      repository,
      startInChat,
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(discardSession).toHaveBeenCalledWith("app-run-1");
    expect(startInChat).toHaveBeenCalledTimes(1);
    expect(repository.markRunning).toHaveBeenCalledWith(secondJob, {
      applicationSessionId: "app-run-2",
      agentSessionId: "agent-session-2",
    });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("AGENT_SCHEDULE_DISPATCH_FAILED"));
    consoleError.mockRestore();
  });
});

describe("conversation occurrences", () => {
  it("hands the occurrence to its chat queue without preparing a session or starting a turn", async () => {
    const conversationJob: ClaimedAgentSchedule = { ...job, executionContext: "conversation", maxRuns: 6 };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([conversationJob]),
      failClaim: vi.fn(),
      markDispatchStarted: vi.fn(),
      markRunning: vi.fn(),
    };
    const enqueueConversation = vi.fn().mockResolvedValue("queued");
    const prepareSession = vi.fn();
    const startInChat = vi.fn();
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const dispatched = await createAgentScheduleDispatcher({
      discardSession: vi.fn(),
      enqueueConversation,
      prepareHistory: vi.fn(),
      prepareSession,
      repository,
      startInChat,
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(dispatched).toBe(1);
    expect(enqueueConversation).toHaveBeenCalledWith(conversationJob);
    expect(prepareSession).not.toHaveBeenCalled();
    expect(repository.markDispatchStarted).not.toHaveBeenCalled();
    expect(startInChat).not.toHaveBeenCalled();
  });
});
