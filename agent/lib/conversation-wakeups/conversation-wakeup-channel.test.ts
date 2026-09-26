/**
 * Telegram channel lifecycle of a wake-up turn.
 *
 * Constructs covered:
 * - A completed wake-up turn closes its run and does not spend the conversation's turn budget.
 * - A failed wake-up turn closes its run before the failure notice, which may itself fail.
 * - A cancelled wake-up turn closes its run with the cancellation code.
 * - An ordinary turn of the same conversation touches no wake-up run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  channelConfig: null as Record<string, any> | null,
  clearApprovals: vi.fn(),
  finishTurn: vi.fn(async () => true),
  hasPendingOperation: vi.fn(async () => false),
  recordTelegramFailure: vi.fn(),
  recordTurnCompleted: vi.fn(),
  recordTurnFailed: vi.fn(),
}));

vi.mock("eve/channels/telegram", () => ({
  telegramChannel: (config: Record<string, any>) => {
    dependencies.channelConfig = config;
    return config;
  },
}));
vi.mock("../agent-schedules/scheduled-session.js", () => ({
  isScheduledSession: vi.fn(() => false),
  scheduledDeliveryMetadata: vi.fn(() => null),
}));
vi.mock("../sessions/session-context.js", () => ({
  applicationSessionId: vi.fn(() => "application-session-1"),
  registerTelegramDeliveredMessageRoutes: vi.fn(),
}));
vi.mock("../sessions/session-repository.js", () => ({
  sessionRepository: {
    hasPendingOperation: dependencies.hasPendingOperation,
    recordTurnCompleted: dependencies.recordTurnCompleted,
    recordTurnFailed: dependencies.recordTurnFailed,
  },
}));
vi.mock("../telegram-hitl/approval-repository.js", () => ({
  telegramHitlApprovalRepository: { clearForEveSession: dependencies.clearApprovals },
}));
vi.mock("../memory-turn-source.js", () => ({
  bindMemoryTurnSources: vi.fn(),
  releaseMemoryTurnSources: vi.fn(),
}));
vi.mock("../memory-review/memory-review-repository.js", () => ({
  memoryReviewRepository: { batchIdForTurn: vi.fn(async () => null), completeBatch: vi.fn(), failRunning: vi.fn() },
}));
vi.mock("../operational-incidents/telegram-failure.js", () => ({
  recordTelegramFailure: dependencies.recordTelegramFailure,
}));
vi.mock("./conversation-wakeup-run-repository.js", () => ({
  conversationWakeupRunRepository: { admitTurn: vi.fn(), finishTurn: dependencies.finishTurn },
}));

await import("../../channels/telegram.js");

function context(attributes: Record<string, string>) {
  return {
    session: {
      auth: { current: { attributes, principalId: "user-1" } },
      id: "eve-session-1",
      turn: { id: "turn-4" },
    },
  };
}

const wakeupTurn = context({ conversationScheduleRunId: "run-1", telegramChatId: "101" });
const channel = { telegram: { chatId: "101" } };

function handler(event: string) {
  return dependencies.channelConfig?.events?.[event];
}

describe("telegram wake-up turn lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.hasPendingOperation.mockResolvedValue(false);
    dependencies.finishTurn.mockResolvedValue(true);
  });

  it("closes the run of a completed wake-up without spending the turn budget", async () => {
    await handler("turn.completed")({}, channel, wakeupTurn);

    expect(dependencies.finishTurn).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: "application-session-1",
      eveSessionId: "eve-session-1",
      eveTurnId: "turn-4",
      failureCode: null,
      runId: "run-1",
    }));
    expect(dependencies.recordTurnCompleted).toHaveBeenCalledWith("application-session-1", "eve-session-1", false, false);
  });

  it("closes the run of a failed wake-up before its failure notice", async () => {
    dependencies.recordTelegramFailure.mockRejectedValue(new Error("incident store unavailable"));

    await expect(handler("turn.failed")({ code: "AGENT_MODEL_FAILED" }, channel, wakeupTurn)).rejects.toThrow("incident store");

    expect(dependencies.finishTurn).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "AGENT_MODEL_FAILED", runId: "run-1" }));
  });

  it("closes the run of a cancelled wake-up with the cancellation code", async () => {
    await handler("turn.cancelled")({}, channel, wakeupTurn);

    expect(dependencies.finishTurn).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "AGENT_CONVERSATION_WAKEUP_CANCELLED",
      runId: "run-1",
    }));
  });

  it("touches no wake-up run for an ordinary turn of the conversation", async () => {
    await handler("turn.completed")({}, channel, context({ telegramChatId: "101" }));

    expect(dependencies.finishTurn).not.toHaveBeenCalled();
    expect(dependencies.recordTurnCompleted).toHaveBeenCalledWith("application-session-1", "eve-session-1", false, true);
  });
});
