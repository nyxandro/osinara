/**
 * The turn's profile not repeating what the session already showed.
 *
 * Constructs covered:
 * - A turn with its own window asks the show journal what this session showed and hides it.
 * - A turn without a window of its own, a delegated child, hides nothing.
 * - A journal that cannot be read is reported as the journal phase, not as the profile.
 */
import type { SessionAuth, SessionAuthContext } from "../../runtime/context.js";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { createMemoryBlockResolver } from "./turn-blocks.js";

const TEST_TURN_ID = "turn-1";
const authorization = {
  familyId: "family-1",
  groupId: null,
  role: "owner" as const,
  scopes: ["personal" as const, "family" as const],
  telegramActorId: "101",
  telegramActorKind: "telegram_user" as const,
  telegramUserId: "101",
  userId: "user-1",
};

function auth(attributes: SessionAuthContext["attributes"]): SessionAuth {
  return {
    current: { attributes, authenticator: "telegram", principalId: "user-1", principalType: "user" },
    initiator: null,
  };
}

const conversationAuth = auth({
  memoryScopes: ["personal", "family"],
  telegramConversationId: "conversation-1",
  telegramTurnStartedAt: "2026-08-08T10:00:00.000Z",
  telegramUserId: "101",
});
const messages = [{ content: "что купить?", role: "user" }] as ModelMessage[];

function resolverWith(shownRecentlyInSession: () => Promise<ReadonlySet<string>>) {
  const createProfile = vi.fn().mockResolvedValue({ subjects: [] });
  const reportFailure = vi.fn().mockResolvedValue(undefined);
  const resolve = createMemoryBlockResolver({ reportFailure, authorize: () => authorization,
    createProfile, openSelectionWindow: async () => 7, recordOffered: vi.fn(), shownRecentlyInSession,
    retrieve: vi.fn().mockResolvedValue({ diagnostics: { semanticBranchAvailable: true }, memories: [],
      offered: { claimIdByMemoryRef: new Map() },
      rankingByMemoryRef: new Map(), threads: { threads: [], totalCharacters: 0 } }),
  });
  return { createProfile, reportFailure, resolve };
}

describe("profile repeat window", () => {
  it("hides from the profile what this session showed in its recent turns", async () => {
    const shownRecentlyInSession = vi.fn(async () => new Set(["claim-shown"]));
    const { createProfile, resolve } = resolverWith(shownRecentlyInSession);

    await resolve({ messages, session: { auth: conversationAuth, id: "session-1" } }, TEST_TURN_ID);

    expect(shownRecentlyInSession).toHaveBeenCalledWith({
      agentSessionId: "session-1", conversationId: "conversation-1", turnId: TEST_TURN_ID, turnOrdinal: 7,
    });
    expect(createProfile.mock.calls[0]![1]).toMatchObject({ hiddenClaimIds: new Set(["claim-shown"]) });
  });

  it("gives a delegated child the whole profile: it has no session history to have seen anything in", async () => {
    const shownRecentlyInSession = vi.fn(async () => new Set(["claim-shown"]));
    const { createProfile, resolve } = resolverWith(shownRecentlyInSession);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await resolve({
        channel: { kind: "subagent" }, messages, session: { auth: conversationAuth, id: "session-1" },
      }, TEST_TURN_ID);
    } finally { info.mockRestore(); }

    expect(shownRecentlyInSession).not.toHaveBeenCalled();
    expect(createProfile.mock.calls[0]![1]).toMatchObject({ hiddenClaimIds: new Set() });
  });

  it("reports an unreadable journal as the journal phase and says memory is unavailable", async () => {
    const { createProfile, reportFailure, resolve } = resolverWith(async () => {
      throw new Error("journal unavailable");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    let block: string | null;
    try {
      block = await resolve({ messages, session: { auth: conversationAuth, id: "session-1" } }, TEST_TURN_ID);
    } finally {
      error.mockRestore();
      info.mockRestore();
    }

    expect(block).toContain("AGENT_MEMORY_UNAVAILABLE");
    expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({ phase: "journal" }));
    expect(createProfile).not.toHaveBeenCalled();
  });
});
