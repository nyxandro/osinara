import { describe, expect, it, vi } from "vitest";
import { AppError } from "../app-error.js";
import { createMemoryBlockResolver, type TurnBlockContext } from "./turn-blocks.js";
import type { MemoryAuthorization } from "../memory-context.js";

const authorization: MemoryAuthorization = {
  familyId: "family", groupId: null, role: "owner", scopes: ["personal"],
  telegramActorId: "101", telegramActorKind: "telegram_user", telegramUserId: "101", userId: "user",
};
const context: TurnBlockContext = {
  messages: [{ role: "user", content: "Собери дайджест: частный текст" }],
  session: { id: "session", auth: { initiator: null, current: {
    principalId: "user", principalType: "user", authenticator: "telegram",
    attributes: { scheduledRunId: "run", scheduleId: "schedule" },
  } } },
};

describe("memory failure ownership", () => {
  it.each(["authorization", "retrieval", "profile"] as const)("records the %s failure against this run without private text", async phase => {
    const error = new AppError("AGENT_TEST_MEMORY_FAILED", "private diagnostic text");
    const reportFailure = vi.fn().mockResolvedValue(undefined);
    const retrieve = vi.fn().mockResolvedValue({ memories: [], retrievedClaimIds: [], threads: { threads: [], totalCharacters: 0 } });
    const createProfile = vi.fn().mockRejectedValue(error);
    if (phase === "retrieval") retrieve.mockRejectedValue(error);
    const resolve = createMemoryBlockResolver({
      authorize: () => { if (phase === "authorization") throw error; return authorization; },
      openSelectionWindow: async () => 1, retrieve, createProfile, reportFailure,
    });
    const ctx = phase !== "profile" ? context : { ...context, session: { ...context.session, auth: {
      ...context.session.auth, current: { ...context.session.auth.current!, attributes: {
        ...context.session.auth.current!.attributes, telegramConversationId: "conversation", telegramUserId: "101",
        telegramTurnStartedAt: "2026-09-13T07:00:00Z",
      } },
    } } };
    expect(await resolve(ctx, "turn_0")).toContain("AGENT_MEMORY_UNAVAILABLE");
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith({
      causeCode: "AGENT_TEST_MEMORY_FAILED", phase, runId: "run", scheduleId: "schedule", sessionId: "session", turnId: "turn_0",
    });
    expect(JSON.stringify(reportFailure.mock.calls)).not.toMatch(/private|частный/);
    if (phase === "authorization") expect(retrieve).not.toHaveBeenCalled();
  });

  it("keeps the explicit unavailable block if the incident database is also unavailable", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const resolve = createMemoryBlockResolver({ authorize: () => authorization,
        openSelectionWindow: async () => 1,
        retrieve: vi.fn().mockRejectedValue(new Error("unavailable")), createProfile: vi.fn(),
        reportFailure: vi.fn().mockRejectedValue(new Error("incident DB down")),
      });
      expect(await resolve(context, "turn_0")).toContain("AGENT_MEMORY_UNAVAILABLE");
      expect(log.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(expect.objectContaining({
        code: "AGENT_MEMORY_INCIDENT_RECORD_FAILED", sessionId: "session", turnId: "turn_0",
      }));
    } finally { log.mockRestore(); }
  });
});
