/**
 * Used-memory reinforcement tests.
 *
 * Constructs covered:
 * - Only refs shown in the current turn reach the repository; the rest are logged as unknown.
 * - A repository failure is logged and never thrown into the delivery path.
 * - An answer without the directive while records were shown is logged, so the share of turns
 *   that ignore the directive can be measured in production.
 */
import type { SessionContext } from "eve/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reinforceUsedMemories } from "./memory-used-reinforcement.js";

const ctx = {
  session: {
    auth: {
      current: {
        attributes: {
          familyId: "family-1",
          memoryScopes: ["family"],
          role: "owner",
          telegramActorId: "101",
          telegramActorKind: "telegram_user",
          telegramUserId: "101",
        },
        authenticator: "telegram",
        principalId: "user-1",
        principalType: "user",
      },
      initiator: null,
    },
    id: "eve-session-1",
    turn: { id: "turn-1" },
  },
} as unknown as Pick<SessionContext, "session">;

describe("reinforceUsedMemories", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reinforces only refs shown in this turn and logs the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const reinforceByRefs = vi.fn().mockResolvedValue({ reinforced: ["mem_a"], unknown: [] });
    await reinforceUsedMemories({ applicationSessionId: "app-1", ctx, declared: true, memoryRefs: ["mem_a", "mem_b"] }, {
      exposures: {
        sessionTurn: vi.fn().mockResolvedValue(4),
        shownMemoryRefsForTurn: vi.fn().mockResolvedValue(new Set(["mem_a"])),
      },
      reinforcement: { reinforceByRefs },
    });
    expect(reinforceByRefs).toHaveBeenCalledWith(expect.objectContaining({ familyId: "family-1" }), {
      memoryRefs: ["mem_a"],
      provenance: { sessionId: "eve-session-1", turnId: "turn-1" },
      reason: "model_used",
    });
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ code: "AGENT_MEMORY_REINFORCE_REF_UNKNOWN", refs: ["mem_b"] }));
  });

  it("logs a missing directive when records were shown this turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reinforceByRefs = vi.fn();
    await reinforceUsedMemories({ applicationSessionId: "app-1", ctx, declared: false, memoryRefs: [] }, {
      exposures: {
        sessionTurn: vi.fn().mockResolvedValue(4),
        shownMemoryRefsForTurn: vi.fn().mockResolvedValue(new Set(["mem_a", "mem_b"])),
      },
      reinforcement: { reinforceByRefs },
    });
    expect(reinforceByRefs).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ code: "AGENT_MEMORY_USED_MISSING", shown: 2 }));
  });

  it("stays silent without the directive when nothing was shown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await reinforceUsedMemories({ applicationSessionId: "app-1", ctx, declared: false, memoryRefs: [] }, {
      exposures: {
        sessionTurn: vi.fn().mockResolvedValue(4),
        shownMemoryRefsForTurn: vi.fn().mockResolvedValue(new Set()),
      },
      reinforcement: { reinforceByRefs: vi.fn() },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an empty declared directive as used nothing without a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await reinforceUsedMemories({ applicationSessionId: "app-1", ctx, declared: true, memoryRefs: [] }, {
      exposures: {
        sessionTurn: vi.fn().mockResolvedValue(4),
        shownMemoryRefsForTurn: vi.fn().mockResolvedValue(new Set(["mem_a"])),
      },
      reinforcement: { reinforceByRefs: vi.fn() },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("swallows a repository failure after logging it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(reinforceUsedMemories({ applicationSessionId: "app-1", ctx, declared: true, memoryRefs: ["mem_a"] }, {
      exposures: {
        sessionTurn: vi.fn().mockResolvedValue(4),
        shownMemoryRefsForTurn: vi.fn().mockResolvedValue(new Set(["mem_a"])),
      },
      reinforcement: { reinforceByRefs: vi.fn().mockRejectedValue(new Error("db down")) },
    })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(JSON.stringify({ code: "AGENT_MEMORY_REINFORCE_FAILED", error: "db down" }));
  });
});
