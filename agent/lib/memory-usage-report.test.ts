/**
 * Memory usage line tests.
 *
 * Constructs covered:
 * - The usage line names which shown records the answer rested on and which named refs the turn
 *   never showed, as opaque refs only, so an offline report can tell the two apart per turn.
 * - The line says which kind of message carried it: the final answer or a step before a tool call.
 * - A failed counter is reported in the line and never costs the person the answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionAuth } from "../runtime/context.js";

const { recordUsed } = vi.hoisted(() => ({ recordUsed: vi.fn() }));
vi.mock("./memory-usage-repository.js", () => ({ memoryUsageRepository: { recordUsed } }));

import { recordMemoryUsageDeclaration } from "./memory-usage-report.js";

const SHOWN = "mem_11111111111111111111111111111111";
const NEVER_SHOWN = "mem_22222222222222222222222222222222";

const auth = {
  current: {
    attributes: { telegramConversationId: "conversation-1" },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user",
  },
  initiator: null,
} as SessionAuth;

describe("recordMemoryUsageDeclaration", () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    recordUsed.mockReset();
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => info.mockRestore());

  it("names the used and the never-shown refs and the kind of message that carried them", async () => {
    recordUsed.mockResolvedValue({ counted: [SHOWN], countedFromSelection: [], rejected: [NEVER_SHOWN], used: [SHOWN] });

    await recordMemoryUsageDeclaration({
      agentSessionId: "session-1",
      auth,
      declaration: { answer: "Ответ", declared: true, memoryRefs: [SHOWN, NEVER_SHOWN] },
      finishReason: "stop",
      turnId: "turn-1",
    });

    expect(JSON.parse(info.mock.calls[0]![0] as string)).toEqual({
      code: "AGENT_MEMORY_USAGE_DIRECTIVE",
      countedCount: 1,
      // The record came from a search, not from the selection the share of used offers is about.
      countedSelectionCount: 0,
      declared: true,
      failed: null,
      finishReason: "stop",
      namedCount: 2,
      rejectedCount: 1,
      rejectedRefs: [NEVER_SHOWN],
      sessionId: "session-1",
      turnId: "turn-1",
      usedCount: 1,
      usedRefs: [SHOWN],
    });
  });

  it("tells a progress step apart from the final answer", async () => {
    recordUsed.mockResolvedValue({ counted: [], countedFromSelection: [], rejected: [], used: [] });

    await recordMemoryUsageDeclaration({
      agentSessionId: "session-1",
      auth,
      declaration: { answer: "Сейчас проверю", declared: false, memoryRefs: [] },
      finishReason: "tool-calls",
      turnId: "turn-1",
    });

    expect(recordUsed).toHaveBeenCalledWith(
      { agentSessionId: "session-1", conversationId: "conversation-1", turnId: "turn-1" },
      [],
    );
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toMatchObject({
      declared: false, failed: null, finishReason: "tool-calls", rejectedRefs: [], usedRefs: [],
    });
  });

  it("reports a failed counter in the line instead of failing the answer", async () => {
    recordUsed.mockRejectedValue(new Error("database unavailable"));

    await expect(recordMemoryUsageDeclaration({
      agentSessionId: "session-1",
      auth,
      declaration: { answer: "Ответ", declared: true, memoryRefs: [SHOWN] },
      finishReason: "stop",
      turnId: "turn-1",
    })).resolves.toBeUndefined();

    expect(JSON.parse(info.mock.calls[0]![0] as string)).toMatchObject({
      failed: "UNCLASSIFIED_USAGE_ERROR", namedCount: 1, rejectedRefs: [], usedRefs: [],
    });
  });
});
