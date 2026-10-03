/**
 * Telegram `turn.completed` binding tests for interactive memory review.
 *
 * Constructs covered:
 * - A continuation after a human answer closes the batch of the turn it resumed, though its
 *   authorization lost the marker, and releases that turn's sources.
 * - The marker keeps answering for a replayed terminal event whose batch row was already released.
 * - An ordinary chat turn is recorded as a turn of the conversation and touches no batch.
 * - A turn cancelled by the next message closes its batch instead of waiting for the bound.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  batchForTurn: vi.fn(),
  clearApprovals: vi.fn(),
  completeBatch: vi.fn(),
  failRunning: vi.fn(),
  hasPendingOperation: vi.fn(async () => false),
  recordTurnCompleted: vi.fn(),
  releaseMemoryTurnSources: vi.fn(),
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
}));
vi.mock("./memory-review/memory-review-repository.js", () => ({
  memoryReviewRepository: {
    batchForTurn: dependencies.batchForTurn,
    completeBatch: dependencies.completeBatch,
    failRunning: dependencies.failRunning,
  },
}));

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

describe("telegram memory review turn binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.hasPendingOperation.mockResolvedValue(false);
    dependencies.batchForTurn.mockResolvedValue(null);
  });

  it("closes the batch of the turn a continuation resumed after a human answer", async () => {
    const handler = (telegramTurnEvents as Record<string, any>)["turn.completed"];
    // Продолжение после ответа человека — новый ход с авторизацией ответа: метки пакета в ней нет,
    // а пакет привязан к ходу, который ждал ответа.
    dependencies.batchForTurn.mockResolvedValue({ batchId: "batch-1", agentTurnId: "turn-3" });

    await handler(undefined, {}, context({ telegramUserId: "101" }));

    expect(dependencies.batchForTurn).toHaveBeenCalledWith({
      agentSessionId: "agent-session-1",
      agentTurnId: "turn-4",
    });
    expect(dependencies.completeBatch).toHaveBeenCalledWith(expect.objectContaining({
      batchId: "batch-1",
      agentSessionId: "agent-session-1",
      agentTurnId: "turn-3",
    }));
    // The parked turn's sources are released with the batch it was reviewing.
    expect(dependencies.releaseMemoryTurnSources.mock.calls.map(([ctx]) => ctx.session.turn.id).sort()).toEqual(["turn-3", "turn-4"]);
    // Ход проверки не является ходом разговора и не закрывает чат-сессию сам по себе.
    expect(dependencies.recordTurnCompleted).not.toHaveBeenCalled();
  });

  it("still recognizes a review turn from its marker after the batch row is gone", async () => {
    const handler = (telegramTurnEvents as Record<string, any>)["turn.completed"];

    await handler(undefined, {}, context({ memoryReviewBatchId: "batch-2" }));

    // Пакет освобождён, строки нет, но повтор терминального события остаётся ходом проверки.
    expect(dependencies.batchForTurn).toHaveBeenCalledWith({
      agentSessionId: "agent-session-1", agentTurnId: "turn-4",
    });
    expect(dependencies.completeBatch).toHaveBeenCalledWith(expect.objectContaining({
      batchId: "batch-2",
    }));
    expect(dependencies.recordTurnCompleted).not.toHaveBeenCalled();
  });

  it("records an ordinary chat turn without touching any batch", async () => {
    const handler = (telegramTurnEvents as Record<string, any>)["turn.completed"];

    await handler(undefined, {}, context({ telegramUserId: "101" }));

    expect(dependencies.completeBatch).not.toHaveBeenCalled();
    expect(dependencies.recordTurnCompleted).toHaveBeenCalledWith(
      "application-session-1",
      "agent-session-1",
      false,
      true,
    );
  });

  it("closes the batch of a turn cancelled by the next chat message", async () => {
    const handler = (telegramTurnEvents as Record<string, any>)["turn.cancelled"];
    dependencies.batchForTurn.mockResolvedValue({ batchId: "batch-4", agentTurnId: "turn-4" });

    await handler(undefined, {}, context({ telegramUserId: "101" }));

    // Отмена — самый частый исход в живом чате. Без этого обработчика пакет висел до временной
    // границы, а следующие ходы успевали выстроиться за мёртвой головой.
    expect(dependencies.failRunning).toHaveBeenCalledWith(expect.objectContaining({
      batchId: "batch-4",
      agentSessionId: "agent-session-1",
      agentTurnId: "turn-4",
    }));
  });

  it("keeps the batch open while the turn is parked on a human answer", async () => {
    const handler = (telegramTurnEvents as Record<string, any>)["turn.completed"];
    dependencies.hasPendingOperation.mockResolvedValue(true);
    dependencies.batchForTurn.mockResolvedValue({ batchId: "batch-3", agentTurnId: "turn-4" });

    await handler(undefined, {}, context({ memoryReviewBatchId: "batch-3" }));

    // Ход ещё продолжится после ответа, поэтому пакет и его источники остаются на месте.
    expect(dependencies.completeBatch).not.toHaveBeenCalled();
    expect(dependencies.releaseMemoryTurnSources).not.toHaveBeenCalled();
    expect(dependencies.recordTurnCompleted).not.toHaveBeenCalled();
  });
});
