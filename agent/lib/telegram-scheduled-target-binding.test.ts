/**
 * Scheduled Telegram final-target binding tests.
 *
 * Constructs covered:
 * - `message.completed` rejects a channel target that differs from scheduled auth before delivery.
 * - `turn.failed` terminalizes a mismatched run without notifying the unrelated active target.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  authorizeDelivery: vi.fn(),
  channelConfig: null as Record<string, any> | null,
  clearApprovals: vi.fn(),
  completeDeliveredRun: vi.fn(),
  deliverFinalOutput: vi.fn(),
  failRun: vi.fn(),
  failRunForNotification: vi.fn(),
  postStableMessage: vi.fn(),
  recordTurnFailed: vi.fn(),
  releaseMemoryTurnSources: vi.fn(),
  scheduledDelivery: {
    applicationSessionId: "application-session-1",
    familyId: "family-1",
    forumTopicId: "77",
    groupId: "group-1",
    messageThreadId: "77",
    ownerUserId: null,
    runId: "run-1",
    scheduledFor: "2026-08-10T10:00:00.000Z",
    scope: "group" as const,
    telegramChatId: "-100111",
    title: "Сводка",
  },
  shouldSuppressFailure: vi.fn(),
}));

vi.mock("eve/channels/telegram", () => ({
  telegramChannel: (config: Record<string, any>) => {
    dependencies.channelConfig = config;
    return config;
  },
}));
vi.mock("./agent-schedules/agent-schedule-dispatch-repository.js", () => ({
  agentScheduleDispatchRepository: {
    authorizeDelivery: dependencies.authorizeDelivery,
    completeDeliveredRun: dependencies.completeDeliveredRun,
    failRun: dependencies.failRun,
    failRunForNotification: dependencies.failRunForNotification,
  },
}));
vi.mock("./agent-schedules/scheduled-session.js", () => ({
  isScheduledSession: vi.fn(() => true),
  scheduledDeliveryMetadata: vi.fn(() => dependencies.scheduledDelivery),
}));
vi.mock("./sessions/session-context.js", () => ({
  applicationSessionId: vi.fn(() => "application-session-1"),
  registerTelegramDeliveredMessageRoutes: vi.fn(),
}));
vi.mock("./sessions/session-repository.js", () => ({
  sessionRepository: {
    isCurrentEveSession: vi.fn(async () => true),
    recordTurnFailed: dependencies.recordTurnFailed,
  },
}));
vi.mock("./telegram-final-delivery.js", () => ({
  deliverTelegramFinalOutput: dependencies.deliverFinalOutput,
}));
vi.mock("./telegram-final-delivery-repository.js", () => ({
  telegramFinalDeliveryRepository: {
    shouldSuppressFailureMessage: dependencies.shouldSuppressFailure,
  },
}));
vi.mock("./telegram-hitl/approval-repository.js", () => ({
  telegramHitlApprovalRepository: { clearForEveSession: dependencies.clearApprovals },
}));
vi.mock("./telegram-progress.js", () => ({
  completedTelegramOutput: vi.fn(() => ({ kind: "message", message: "Секретная сводка" })),
}));
vi.mock("./telegram-stable-delivery.js", () => ({
  postTelegramMessageWithoutContinuationChange: dependencies.postStableMessage,
}));
vi.mock("./telegram-group-journal-repository.js", () => ({
  telegramGroupJournalRepository: { recordAgentResponse: vi.fn() },
}));
vi.mock("./conversation-timeline-repository.js", () => ({
  conversationTimelineRepository: { recordAgentResponse: vi.fn() },
}));
vi.mock("./memory-turn-source.js", () => ({
  bindMemoryTurnSources: vi.fn(),
  releaseMemoryTurnSources: dependencies.releaseMemoryTurnSources,
}));

await import("../channels/telegram.js");

const context = {
  session: {
    auth: { current: { attributes: {} }, initiator: null },
    id: "eve-session-1",
    turn: { id: "turn-1", sequence: 1 },
  },
};

function mismatchedChannel() {
  return {
    state: {},
    telegram: {
      chatId: "-100222",
      messageThreadId: 77,
    },
  };
}

function matchingChannel() {
  return {
    state: { chatType: "supergroup" },
    telegram: {
      chatId: "-100111",
      messageThreadId: 77,
    },
  };
}

describe("scheduled Telegram target binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.deliverFinalOutput.mockResolvedValue([{ messageId: "telegram-message-1" }]);
    dependencies.failRun.mockResolvedValue(true);
    dependencies.failRunForNotification.mockResolvedValue(true);
    dependencies.postStableMessage.mockResolvedValue("failure-message-1");
    dependencies.shouldSuppressFailure.mockResolvedValue(false);
  });

  it("rejects a completed result before authorization or Telegram delivery when chat differs", async () => {
    const handler = dependencies.channelConfig?.events?.["message.completed"];

    await expect(handler(
      { finishReason: "stop", message: "Секретная сводка" },
      mismatchedChannel(),
      context,
    )).rejects.toMatchObject({
      code: "AGENT_SCHEDULE_DELIVERY_TARGET_MISMATCH",
      message: expect.stringContaining("цель Telegram"),
    });

    expect(dependencies.authorizeDelivery).not.toHaveBeenCalled();
    expect(dependencies.deliverFinalOutput).not.toHaveBeenCalled();
  });

  it("rejects a completed result when only the Telegram topic differs", async () => {
    const handler = dependencies.channelConfig?.events?.["message.completed"];
    const channel = matchingChannel();
    channel.telegram.messageThreadId = 78;

    await expect(handler(
      { finishReason: "stop", message: "Секретная сводка" },
      channel,
      context,
    )).rejects.toMatchObject({ code: "AGENT_SCHEDULE_DELIVERY_TARGET_MISMATCH" });

    expect(dependencies.authorizeDelivery).not.toHaveBeenCalled();
    expect(dependencies.deliverFinalOutput).not.toHaveBeenCalled();
  });

  it("normalizes and accepts the exact persisted chat and topic before delivery", async () => {
    const handler = dependencies.channelConfig?.events?.["message.completed"];

    await expect(handler(
      { finishReason: "stop", message: "Секретная сводка" },
      matchingChannel(),
      context,
    )).resolves.toBeUndefined();

    expect(dependencies.authorizeDelivery).toHaveBeenCalledOnce();
    expect(dependencies.deliverFinalOutput).toHaveBeenCalledOnce();
  });

  it("fails a mismatched run without sending its failure notification to another chat", async () => {
    const handler = dependencies.channelConfig?.events?.["turn.failed"];

    await handler(
      { code: "AGENT_MODEL_FAILED" },
      mismatchedChannel(),
      context,
    );

    expect(dependencies.failRun).toHaveBeenCalledWith(
      "application-session-1",
      "eve-session-1",
      "AGENT_SCHEDULE_DELIVERY_TARGET_MISMATCH",
      expect.any(Date),
    );
    expect(dependencies.failRunForNotification).not.toHaveBeenCalled();
    expect(dependencies.postStableMessage).not.toHaveBeenCalled();
    expect(dependencies.recordTurnFailed).toHaveBeenCalledWith(
      "application-session-1",
      "eve-session-1",
    );
    expect(dependencies.clearApprovals).toHaveBeenCalledWith(
      "application-session-1",
      "eve-session-1",
    );
    expect(dependencies.releaseMemoryTurnSources).toHaveBeenCalledWith(context);
  });

  it("terminalizes a matching group run without publishing a failure message", async () => {
    const handler = dependencies.channelConfig?.events?.["turn.failed"];

    await handler(
      { code: "AGENT_MODEL_FAILED" },
      matchingChannel(),
      context,
    );

    expect(dependencies.failRunForNotification).toHaveBeenCalledOnce();
    expect(dependencies.postStableMessage).not.toHaveBeenCalled();
    expect(dependencies.recordTurnFailed).toHaveBeenCalledWith(
      "application-session-1",
      "eve-session-1",
    );
    expect(dependencies.clearApprovals).toHaveBeenCalledWith(
      "application-session-1",
      "eve-session-1",
    );
  });
});
