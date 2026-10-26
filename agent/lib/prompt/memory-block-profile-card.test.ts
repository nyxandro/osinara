/**
 * The turn's profile card kept in the conversation instead of living one turn.
 *
 * Constructs covered:
 * - A conversation turn writes new facts into history as a card; the turn block keeps only people.
 * - Facts a card in history still holds are not sent again; past the window or compaction they are.
 * - A fact the history holds but memory no longer gives is withdrawn in the next card.
 * - A delegated child keeps the whole profile inside its own turn and writes no card.
 * - A failed check is reported as the profile phase and disclosed as unavailable memory.
 */
import type { SessionAuth, SessionAuthContext } from "../../runtime/context.js";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { PROFILE_REPEAT_WINDOW_TURNS } from "../memory-config.js";
import type { ProfileView } from "../profile-view.js";
import { formatProfileCard, profilePersonKey } from "./profile-card.js";
import { createMemoryBlockResolver } from "./turn-blocks.js";

const TEST_TURN_ID = "turn-1";
const TURN_ORDINAL = 30;
const VIEW_REF = "view_11111111111111111111111111111111";
const SUBJECT_REF = "subj_11111111111111111111111111111111";
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
  telegramTurnStartedAt: "2026-10-26T10:00:00.000Z",
  telegramUserId: "101",
});
const question: ModelMessage = { content: "что мне заказать?", role: "user" };

function claim(memoryRef: string, content: string) {
  return {
    confirmation: "user_confirmed" as const,
    content,
    evidenceKind: "firsthand" as const,
    kind: "preference" as const,
    memoryRef,
    observedAt: "2026-10-20T10:00:00.000Z",
    origin: { label: "Личный чат", scope: "personal" as const },
    sourceAuthorLabel: "Пух",
  };
}

function view(claims: ReturnType<typeof claim>[], claimsInContext = 0): ProfileView {
  return {
    generatedAt: "2026-10-26T10:00:00.000Z",
    profileViewRef: VIEW_REF,
    subjects: [{
      claims,
      ...(claimsInContext === 0 ? {} : { claimsInContext }),
      label: "Пух",
      priority: "current_author",
      subjectRef: SUBJECT_REF,
      totalCharacters: claims.reduce((sum, item) => sum + item.content.length, 0),
    }],
    totalCharacters: 0,
  };
}

function historyCard(shownAtTurn: number, refs: readonly string[]): ModelMessage {
  return {
    role: "user",
    content: formatProfileCard({
      people: [{
        facts: refs.map((ref) => claim(ref, `факт ${ref}`)), label: "Пух", personKey: profilePersonKey(SUBJECT_REF),
      }],
      profileViewRef: VIEW_REF,
      shownAtTurn,
      withdrawn: [],
    })!,
  };
}

function resolverWith(input: {
  profile: ProfileView;
  readable?: (refs: readonly string[]) => Promise<ReadonlySet<string>>;
}) {
  const createProfile = vi.fn().mockResolvedValue(input.profile);
  const readableMemoryRefs = vi.fn(
    async (_auth: unknown, _conversationId: string, refs: readonly string[]) =>
      input.readable ? await input.readable(refs) : new Set(refs),
  );
  const reportFailure = vi.fn().mockResolvedValue(undefined);
  const resolve = createMemoryBlockResolver({ reportFailure, authorize: () => authorization,
    createProfile, openSelectionWindow: async () => TURN_ORDINAL, readableMemoryRefs, recordOffered: vi.fn(),
    retrieve: vi.fn().mockResolvedValue({ diagnostics: { semanticBranchAvailable: true }, memories: [],
      offered: { claimIdByMemoryRef: new Map() },
      rankingByMemoryRef: new Map(), threads: { threads: [], totalCharacters: 0 } }),
  });
  return { createProfile, readableMemoryRefs, reportFailure, resolve };
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return await run();
  } finally {
    info.mockRestore();
    error.mockRestore();
  }
}

describe("profile card of a conversation turn", () => {
  it("writes new facts into history as a card and keeps only the people in the turn block", async () => {
    const { createProfile, resolve } = resolverWith({ profile: view([claim("mem_a", "любит улун")]) });

    const blocks = await quietly(() => resolve(
      { messages: [question], session: { auth: conversationAuth, id: "session-1" } }, TEST_TURN_ID,
    ));

    expect(createProfile.mock.calls[0]![1]).toMatchObject({ inContextMemoryRefs: new Set() });
    expect(blocks.profileCard).toContain(`<profile_card shownAtTurn="${TURN_ORDINAL}" profileViewRef="${VIEW_REF}">`);
    expect(blocks.profileCard).toContain("любит улун");
    expect(blocks.memory).toContain(`<verified_profile_view profileViewRef="${VIEW_REF}">`);
    expect(blocks.memory).toContain(SUBJECT_REF);
    expect(blocks.memory).not.toContain("любит улун");
  });

  it("does not send again what a card in history still holds", async () => {
    const { createProfile, resolve } = resolverWith({ profile: view([], 1) });
    const history = [historyCard(TURN_ORDINAL - 1, ["mem_a"]), { role: "assistant", content: "ок" } as ModelMessage];

    const blocks = await quietly(() => resolve(
      { messages: [...history, question], session: { auth: conversationAuth, id: "session-1" } }, TEST_TURN_ID,
    ));

    expect(createProfile.mock.calls[0]![1]).toMatchObject({ inContextMemoryRefs: new Set(["mem_a"]) });
    expect(blocks.profileCard).toBeNull();
    // The person stays in the turn block with their ref, so a new fact about them can name them.
    expect(blocks.memory).toContain(SUBJECT_REF);
  });

  it("sends the facts again once the card is older than the repeat window", async () => {
    const { createProfile, resolve } = resolverWith({ profile: view([claim("mem_a", "любит улун")]) });
    const history = [historyCard(TURN_ORDINAL - PROFILE_REPEAT_WINDOW_TURNS, ["mem_a"])];

    const blocks = await quietly(() => resolve(
      { messages: [...history, question], session: { auth: conversationAuth, id: "session-1" } }, TEST_TURN_ID,
    ));

    expect(createProfile.mock.calls[0]![1]).toMatchObject({ inContextMemoryRefs: new Set() });
    expect(blocks.profileCard).toContain("любит улун");
  });

  it("withdraws a fact the history holds but memory no longer gives", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { readableMemoryRefs, resolve } = resolverWith({
      profile: view([], 1),
      readable: async () => new Set(["mem_b"]),
    });
    const history = [historyCard(TURN_ORDINAL - 2, ["mem_a", "mem_b"])];

    let blocks: Awaited<ReturnType<typeof resolve>>;
    try {
      blocks = await resolve(
        { messages: [...history, question], session: { auth: conversationAuth, id: "session-1" } }, TEST_TURN_ID,
      );
      expect(JSON.parse(info.mock.calls[0]![0] as string)).toMatchObject({
        code: "AGENT_MEMORY_RETRIEVAL_METRICS", profileWithdrawnClaims: 1,
      });
    } finally { info.mockRestore(); }

    expect(readableMemoryRefs).toHaveBeenCalledWith(authorization, "conversation-1", ["mem_a", "mem_b"]);
    expect(blocks.profileCard).toContain('"withdrawn":["mem_a"]');
  });

  it("gives a delegated child the whole profile inside its own turn and writes no card", async () => {
    const { createProfile, readableMemoryRefs, resolve } = resolverWith({
      profile: view([claim("mem_a", "любит улун")]),
    });

    const blocks = await quietly(() => resolve({
      channel: { kind: "subagent" },
      messages: [historyCard(TURN_ORDINAL - 1, ["mem_a"]), question],
      session: { auth: conversationAuth, id: "session-1" },
    }, TEST_TURN_ID));

    expect(createProfile.mock.calls[0]![1]).toMatchObject({ inContextMemoryRefs: new Set() });
    expect(readableMemoryRefs).not.toHaveBeenCalled();
    expect(blocks.profileCard).toBeNull();
    expect(blocks.memory).toContain("любит улун");
  });

  it("reports a failed check as the profile phase and says memory is unavailable", async () => {
    const { reportFailure, resolve } = resolverWith({
      profile: view([claim("mem_a", "любит улун")]),
      readable: async () => { throw new Error("database unavailable"); },
    });

    const blocks = await quietly(() => resolve({
      messages: [historyCard(TURN_ORDINAL - 1, ["mem_a"]), question],
      session: { auth: conversationAuth, id: "session-1" },
    }, TEST_TURN_ID));

    expect(blocks.memory).toContain("AGENT_MEMORY_UNAVAILABLE");
    expect(blocks.profileCard).toBeNull();
    expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({ phase: "profile" }));
  });
});
