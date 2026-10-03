/**
 * Turn-bound memory source selection tests.
 *
 * Constructs covered:
 * - `bindMemoryTurnSources`: accepts only an exact durable HITL resume and ignores scheduled runs.
 * - `resolveMemoryTurnSource`: current source default and visible group-delta sequence selection.
 * - Personal turns reject historical source selection even if a sequence is supplied.
 * - A selected source must remain bound to the same verified caller and memory partition.
 */
import { describe, expect, it, vi } from "vitest";

const { bind, bindReview, release, resolve, verifyBoundResume } = vi.hoisted(() => ({
  bind: vi.fn(),
  bindReview: vi.fn(),
  release: vi.fn(),
  resolve: vi.fn(),
  verifyBoundResume: vi.fn(),
}));

vi.mock("./memory-turn-source-repository.js", () => ({
  memoryTurnSourceRepository: {
    bind,
    bindReview,
    release,
    resolve,
    verifyBoundResume,
  },
}));

import type { MemoryAuthorization } from "./memory-context.js";
import { bindMemoryTurnSources, resolveMemoryTurnSource } from "./memory-turn-source.js";

const groupAuthorization: MemoryAuthorization = {
  familyId: "family-1",
  groupId: "group-1",
  role: "external",
  scopes: ["group"],
  telegramActorId: "caller-1",
  telegramActorKind: "telegram_user",
  telegramUserId: "caller-1",
  userId: null,
};
const context = {
  session: {
    auth: { current: null, initiator: null },
    id: "agent-session-1",
    turn: { id: "agent-turn-1", sequence: 0 },
  },
} as never;

describe("turn-bound memory source selection", () => {
  it("does not bind a prompt button as a new fact source", async () => {
    bind.mockClear(); verifyBoundResume.mockClear();
    await bindMemoryTurnSources({ session: { auth: { current: { attributes: {
      applicationSessionId: "session", telegramApprovalContinuation: "true",
    } } }, id: "agent-session", turn: { id: "turn_2" } } } as never);
    expect(bind).not.toHaveBeenCalled();
    expect(verifyBoundResume).not.toHaveBeenCalled();
  });
  it("accepts an HITL resume only when its durable source binding matches", async () => {
    verifyBoundResume.mockResolvedValueOnce(true);
    const resumed = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "application-session-1",
              telegramActorId: "caller-1",
              telegramActorKind: "telegram_user",
              telegramUserId: "caller-1",
            },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "agent-session-1",
        turn: { id: "agent-turn-1", sequence: 0 },
      },
    } as never;

    await expect(bindMemoryTurnSources(resumed)).resolves.toBeUndefined();
    expect(verifyBoundResume).toHaveBeenCalledWith({
      applicationSessionId: "application-session-1",
      agentSessionId: "agent-session-1",
      agentTurnId: "agent-turn-1",
      invokingActorId: "caller-1",
      invokingActorKind: "telegram_user",
    });
    expect(bind).not.toHaveBeenCalled();
  });

  it("does not require a Telegram source binding for a scheduled run", async () => {
    verifyBoundResume.mockClear();
    const scheduled = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "scheduled-session-1",
              scheduledRunId: "scheduled-run-1",
            },
          },
          initiator: null,
        },
        id: "scheduled-agent-session-1",
        turn: { id: "scheduled-agent-turn-1", sequence: 0 },
      },
    } as never;

    await expect(bindMemoryTurnSources(scheduled)).resolves.toBeUndefined();
    expect(verifyBoundResume).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("selects a visible group-delta source by rendered sequence", async () => {
    resolve.mockResolvedValueOnce({
      conversationId: "conversation-1",
      invokingActorId: "caller-1",
      invokingActorKind: "telegram_user",
      isCurrent: false,
      isReview: false,
      messageThreadId: null,
      scope: "group",
      scopePartitionKey: "group-1",
      sourceMessageId: "420",
      timelineEntryId: "entry-42",
    });

    await expect(resolveMemoryTurnSource(context, groupAuthorization, "42")).resolves.toEqual({
      conversationId: "conversation-1",
      isCurrent: false,
      isReview: false,
      messageThreadId: null,
      sourceMessageId: "420",
      timelineEntryId: "entry-42",
    });
    expect(resolve).toHaveBeenCalledWith({
      agentSessionId: "agent-session-1",
      agentTurnId: "agent-turn-1",
      sourceSequence: "42",
    });
  });

  it("rejects sourceSequence in a personal turn before repository access", async () => {
    resolve.mockClear();
    const personal: MemoryAuthorization = {
      ...groupAuthorization,
      groupId: null,
      scopes: ["personal"],
    };

    await expect(resolveMemoryTurnSource(context, personal, "42")).rejects.toMatchObject({ code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects a source bound to another invoking Telegram caller", async () => {
    resolve.mockResolvedValueOnce({
      conversationId: "conversation-1",
      invokingActorId: "caller-2",
      invokingActorKind: "telegram_user",
      isCurrent: false,
      isReview: false,
      messageThreadId: null,
      scope: "group",
      scopePartitionKey: "group-1",
      sourceMessageId: "420",
      timelineEntryId: "entry-42",
    });

    await expect(resolveMemoryTurnSource(context, groupAuthorization, "42")).rejects.toMatchObject({ code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID" });
  });
});
