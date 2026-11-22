/**
 * Telegram terminal bookkeeping of a chat turn (#569).
 *
 * Constructs covered:
 * - A finished group turn is recorded as a turn of its conversation: group memory is reviewed only in
 *   the background, so a chat turn owns no review batch, even one that still carries an old marker.
 * - A finished turn releases its own sources and those of the turns it resumes after a human answer.
 * - A turn parked on a human answer keeps its sources until it finishes.
 * - A cancelled turn releases its sources the same way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  clearApprovals: vi.fn(),
  hasPendingOperation: vi.fn(async () => false),
  recordTurnCompleted: vi.fn(),
  releaseMemoryTurnSources: vi.fn(),
  releaseResumedMemoryTurnSources: vi.fn(),
}));

vi.mock("./agent-schedules/scheduled-session.js", () => ({
  isScheduledSession: vi.fn(() => false),
  scheduledDeliveryMetadata: vi.fn(() => null),
}));
vi.mock("./sessions/session-context.js", () => ({
  applicationSessionId: vi.fn(() => "application-session-1"),
  registerTelegramDeliveredMessageRoutes: vi.fn(),
}));
vi.mock("./sessions/session-repository.js", () => ({
  sessionRepository: {
    hasPendingOperation: dependencies.hasPendingOperation,
    recordTurnCompleted: dependencies.recordTurnCompleted,
  },
}));
vi.mock("./telegram-hitl/approval-repository.js", () => ({
  telegramHitlApprovalRepository: { clearForAgentSession: dependencies.clearApprovals },
}));
vi.mock("./memory-turn-source.js", () => ({
  bindMemoryTurnSources: vi.fn(),
  releaseMemoryTurnSources: dependencies.releaseMemoryTurnSources,
  releaseResumedMemoryTurnSources: dependencies.releaseResumedMemoryTurnSources,
}));

vi.mock("./reply-buttons/reply-button-delivery.js", () => ({ reportUndeliveredReplyButtons: vi.fn(), turnReplyButtons: vi.fn(() => null) }));
const { telegramTurnEvents } = await import("../channels/telegram.js");

function context(attributes: Record<string, string>) {
  return {
    session: {
      auth: { current: { attributes, principalId: "user-1" } },
      id: "agent-session-1",
      turn: { id: "turn-4" },
    },
  };
}

describe("telegram turn session bookkeeping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.hasPendingOperation.mockResolvedValue(false);
  });

  it("records a finished chat turn and releases its sources and the turns it resumes", async () => {
    const handler = (telegramTurnEvents as Record<string, any>)["turn.completed"];

    await handler(undefined, {}, context({ telegramUserId: "101" }));

    expect(dependencies.recordTurnCompleted).toHaveBeenCalledWith(
      "application-session-1",
      "agent-session-1",
      false,
      true,
    );
    expect(dependencies.releaseMemoryTurnSources).toHaveBeenCalledOnce();
    expect(dependencies.releaseResumedMemoryTurnSources).toHaveBeenCalledOnce();
  });

  it("records a turn that still carries a review marker as an ordinary conversation turn", async () => {
    const handler = (telegramTurnEvents as Record<string, any>)["turn.completed"];

    await handler(undefined, {}, context({ memoryReviewBatchId: "batch-2", telegramUserId: "101" }));

    expect(dependencies.recordTurnCompleted).toHaveBeenCalledOnce();
  });

  it("keeps a parked turn's sources until it finishes", async () => {
    const handler = (telegramTurnEvents as Record<string, any>)["turn.completed"];
    dependencies.hasPendingOperation.mockResolvedValue(true);

    await handler(undefined, {}, context({ telegramUserId: "101" }));

    expect(dependencies.releaseMemoryTurnSources).not.toHaveBeenCalled();
    expect(dependencies.releaseResumedMemoryTurnSources).not.toHaveBeenCalled();
    expect(dependencies.recordTurnCompleted).toHaveBeenCalledWith(
      "application-session-1",
      "agent-session-1",
      true,
      true,
    );
  });

  it("releases a cancelled turn's sources and the turns it resumes", async () => {
    const handler = (telegramTurnEvents as Record<string, any>)["turn.cancelled"];

    await handler(undefined, {}, context({ telegramUserId: "101" }));

    expect(dependencies.releaseMemoryTurnSources).toHaveBeenCalledOnce();
    expect(dependencies.releaseResumedMemoryTurnSources).toHaveBeenCalledOnce();
  });
});
