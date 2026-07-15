/**
 * Agent schedule dispatcher unit tests.
 *
 * Constructs covered:
 * - `createAgentScheduleDispatcher`: prepares isolated Telegram receive target and trusted auth.
 */
import { describe, expect, it, vi } from "vitest";

import { createAgentScheduleDispatcher } from "./agent-schedule-dispatcher.js";
import type { ClaimedAgentSchedule } from "./agent-schedule-dispatch-repository.js";

const job: ClaimedAgentSchedule = {
  authorUserId: "user-1",
  familyId: "family-1",
  groupId: null,
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
    const receive = vi.fn().mockResolvedValue({
      continuationToken: "101::schedule:run-1",
      getEventStream: vi.fn(),
      id: "eve-session-1",
    });

    const dispatched = await createAgentScheduleDispatcher({
      prepareSession,
      receive,
      repository,
    })(new Date("2026-07-17T06:00:00.000Z"));

    expect(dispatched).toBe(1);
    expect(prepareSession).toHaveBeenCalledWith(
      job,
      "101::schedule:run-1",
      new Date("2026-07-17T06:00:00.000Z"),
    );
    expect(receive).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      auth: expect.objectContaining({
        attributes: expect.objectContaining({
          applicationSessionId: "app-session-1",
          memoryScopes: ["personal", "family"],
          scheduledRunId: "run-1",
        }),
        authenticator: "telegram",
        principalId: "user-1",
      }),
      message: expect.stringContaining("<scheduled_agent_run>"),
      target: { chatId: "101", conversationId: "schedule:run-1" },
    }));
    expect(repository.markRunning).toHaveBeenCalledWith(job, {
      applicationSessionId: "app-session-1",
      eveSessionId: "eve-session-1",
    });
  });
});
