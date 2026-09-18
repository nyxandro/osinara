/**
 * Scheduled Telegram final-target binding tests.
 *
 * Constructs covered:
 * - `message.completed` rejects a channel target that differs from scheduled auth before delivery.
 * - Scheduled final-delivery failures persist their primary stable code before terminal fallback.
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
  recordTelegramFailure: vi.fn(),
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
// Recording the incident is the last step of a notified failure, and it reads the database first.
// Without this the test needs a live PostgreSQL to pass, which is why it only ever went green in CI.
vi.mock("./operational-incidents/telegram-failure.js", () => ({
  recordTelegramFailure: dependencies.recordTelegramFailure,
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
// A scheduled run never carries a memory-review batch, but the channel now resolves that binding
// from the database instead of the message authorization, so the lookup has to be answered.
vi.mock("./memory-review/memory-review-repository.js", () => ({
  memoryReviewRepository: { batchIdForTurn: vi.fn(async () => null) },
}));

await import("../channels/telegram.js");
const { AppError } = await import("./app-error.js");

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

  it("persists the primary scheduled delivery error before the terminal fallback runs", async () => {
    const handler = dependencies.channelConfig?.events?.["message.completed"];
    dependencies.deliverFinalOutput.mockRejectedValueOnce(new AppError(
      "AGENT_TELEGRAM_MESSAGE_DELIVERY_AMBIGUOUS",
      "Telegram не подтвердил доставку",
    ));

    await expect(handler(
      { finishReason: "stop", message: "Секретная сводка" },
      matchingChannel(),
      context,
    )).rejects.toMatchObject({ code: "AGENT_TELEGRAM_MESSAGE_DELIVERY_AMBIGUOUS" });

    expect(dependencies.failRun).toHaveBeenCalledWith(
      "application-session-1",
      "eve-session-1",
      "AGENT_TELEGRAM_MESSAGE_DELIVERY_AMBIGUOUS",
      expect.any(Date),
    );
  });

  it("preserves the primary delivery error when terminal persistence also fails", async () => {
    const handler = dependencies.channelConfig?.events?.["message.completed"];
    const deliveryError = new AppError(
      "AGENT_TELEGRAM_MESSAGE_DELIVERY_AMBIGUOUS",
      "Telegram не подтвердил доставку",
    );
    dependencies.deliverFinalOutput.mockRejectedValueOnce(deliveryError);
    dependencies.failRun.mockRejectedValueOnce(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(handler(
      { finishReason: "stop", message: "Секретная сводка" },
      matchingChannel(),
      context,
    )).rejects.toBe(deliveryError);

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
      "AGENT_SCHEDULE_FINAL_DELIVERY_FAILURE_PERSISTENCE_FAILED",
    ));
    consoleError.mockRestore();
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
    // The other half of "never notify a target that was not approved": no owner-facing incident
    // either, or the unrelated chat would learn about a failure that has nothing to do with it.
    expect(dependencies.recordTelegramFailure).not.toHaveBeenCalled();
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
    // The run is terminalized quietly, but the owner-facing incident is still recorded: that is
    // what "without publishing a failure message" means here, and it is the reason the handler
    // reaches the incident recorder at all.
    // Checked exactly, chat included: binding the incident to the right chat is what this whole
    // file is about, and a loose match would let "recorded against someone else's chat" pass.
    expect(dependencies.recordTelegramFailure).toHaveBeenCalledWith({
      chatId: "-100111",
      code: "AGENT_MODEL_FAILED",
      sessionId: "eve-session-1",
      turnId: "turn-1",
    });
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
