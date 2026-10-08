/**
 * The automatic selection of one turn: what reaches the model when it should stay silent.
 *
 * Constructs covered:
 * - A message that asks memory nothing is not searched and offers no records, saying so in diagnostics.
 * - A message with any word outside small talk is searched as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MEMORY_EMBEDDING_DIMENSIONS } from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { ReferencedMemoryItem } from "./memory-record.js";
import { memoryRetrievalRepository } from "./memory-retrieval-repository.js";
import type { MemoryRetrievalBranchDiagnostics } from "./memory-retrieval-ranking.js";
import { retrieveMemoryTurnContext } from "./memory-retrieval.js";
import { memoryThreadBriefRepository } from "./memory-thread-brief-repository.js";

vi.mock("./memory-embedding-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./memory-embedding-client.js")>(),
  embedMemoryQueryChunks: vi.fn(async () => [Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0.1)]),
}));

const auth: MemoryAuthorization = {
  familyId: "family-1",
  groupId: "group-1",
  role: "member",
  scopes: ["group"],
  telegramActorId: "actor-1",
  telegramActorKind: "telegram_user",
  telegramUserId: "actor-1",
  userId: null,
};

const record: ReferencedMemoryItem = {
  attribute: null,
  author: { status: "current_member", telegramUserId: "actor-2", userId: null },
  confirmation: "user_confirmed",
  content: "Участники чата в шутку называют его чатом каблуков",
  createdAt: "2026-09-01T10:00:00.000Z",
  embeddingStatus: "indexed",
  id: "claim-1",
  kind: "fact",
  memoryRef: "mem_0123456789abcdef0123456789abcdef",
  messageThreadId: null,
  occurredOn: null,
  scope: "group",
  sensitivity: "normal",
  source: "test:turn-context",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

function search(overrides: Partial<MemoryRetrievalBranchDiagnostics>) {
  const diagnostics: MemoryRetrievalBranchDiagnostics = {
    candidateLimitHit: false, recentlyShown: 0,
    russianMatched: 0, russianQualified: 0, russianTopRank: null,
    semanticMatched: 40, semanticQualified: 12, semanticTopSimilarity: 0.815,
    simpleMatched: 0, simpleQualified: 0, simpleTopRank: null,
    ...overrides,
  };
  vi.spyOn(memoryRetrievalRepository, "searchWithConflictClosure").mockResolvedValue({
    claimIdsByConflictRef: new Map(),
    conflicts: [],
    diagnostics,
    relatedClaimIds: [record.id],
    results: [{
      evidence: { russianMorphologyRank: null, semanticSimilarity: 0.815, simpleLexicalRank: null },
      exactDuplicateIdentity: "group",
      subjectLabel: null,
      memory: record,
      score: 0.016,
    }],
  });
}

afterEach(() => vi.restoreAllMocks());

describe("retrieveMemoryTurnContext", () => {
  it("does not search memory for a message that asks it nothing", async () => {
    const searchSpy = vi.spyOn(memoryRetrievalRepository, "searchWithConflictClosure");
    const activate = vi.spyOn(memoryThreadBriefRepository, "activate");

    const context = await retrieveMemoryTurnContext(auth, "Осинара, спасибо, понял", []);

    // 08.10 golden set: 88 of 153 live turns needed no memory and every one got 11.8 records.
    expect(searchSpy).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(context.memories).toEqual([]);
    expect(context.offered.claimIdByMemoryRef.size).toBe(0);
    expect(context.retrievedClaimIds).toEqual([]);
    expect(context.diagnostics.abstained).toBe(true);
  });

  it("searches as before once the message holds a word outside small talk", async () => {
    search({ russianMatched: 3, russianTopRank: 0.1 });
    vi.spyOn(memoryThreadBriefRepository, "activate").mockResolvedValue({ threads: [], totalCharacters: 0 });

    const context = await retrieveMemoryTurnContext(auth, "спасибо, а как называют этот чат?", []);

    expect(context.memories.map((memory) => "memoryRef" in memory ? memory.memoryRef : null))
      .toEqual([record.memoryRef]);
    expect(context.diagnostics.abstained).toBe(false);
  });
});
