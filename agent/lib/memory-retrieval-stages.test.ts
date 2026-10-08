import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryAuthorization } from "./memory-context.js";
import { AppError } from "./app-error.js";
import { MEMORY_RETRIEVAL_LIMIT } from "./memory-config.js";
const mocks = vi.hoisted(() => ({ embedding: vi.fn(), search: vi.fn(), threads: vi.fn() }));
vi.mock("./memory-embedding-client.js", () => ({
  embedMemoryQueryChunks: mocks.embedding,
  memoryQueryCentroid: (vectors: readonly (readonly number[])[]) => [...vectors[0]!],
}));
vi.mock("./memory-retrieval-repository.js", () => ({ memoryRetrievalRepository: { searchWithConflictClosure: mocks.search } }));
vi.mock("./memory-thread-brief-repository.js", () => ({ memoryThreadBriefRepository: { activate: mocks.threads } }));
import { retrieveMemoryTurnContext } from "./memory-retrieval.js";
import { memoryFailureCode } from "./memory-context-failure.js";

const DIAGNOSTICS = {
  candidateLimitHit: false,
  recentlyShown: 0,
  russianQualified: 0, russianMatched: 0, russianTopRank: null,
  semanticQualified: 0, semanticMatched: 0, semanticTopSimilarity: null,
  simpleQualified: 0, simpleMatched: 0, simpleTopRank: null,
};

describe("memory retrieval failure provenance", () => {
  beforeEach(() => {
    mocks.embedding.mockReset().mockResolvedValue([[1]]);
    mocks.search.mockReset().mockResolvedValue({
      claimIdsByConflictRef: new Map(), conflicts: [], relatedClaimIds: [], results: [], diagnostics: DIAGNOSTICS,
    });
    mocks.threads.mockReset().mockResolvedValue({ threads: [], totalCharacters: 0 });
  });
  it.each(["search", "threads"] as const)("keeps the original %s failure and never continues to later stages", async phase => {
    const failure = new AppError("AGENT_TEST_DEPENDENCY_FAILED", "Причина отказа");
    mocks[phase].mockRejectedValue(failure);
    const result = retrieveMemoryTurnContext({} as MemoryAuthorization, "private query", []);
    await expect(result).rejects.toMatchObject({ phase, cause: failure });
    await result.catch(error => expect(memoryFailureCode(error)).toBe("AGENT_TEST_DEPENDENCY_FAILED"));
    if (phase !== "threads") expect(mocks.threads).not.toHaveBeenCalled();
  });

  it("carries on without the embedding service instead of failing the turn", async () => {
    // The word branches search text in PostgreSQL and have nothing to do with that service, so
    // its failure costs the selection its semantic half and nothing else.
    mocks.embedding.mockRejectedValue(new AppError("AGENT_TEST_DEPENDENCY_FAILED", "Причина отказа"));

    const context = await retrieveMemoryTurnContext({} as MemoryAuthorization, "private query", []);

    expect(context.diagnostics.semanticBranchAvailable).toBe(false);
    expect(mocks.search).toHaveBeenCalledWith({}, "private query", [], MEMORY_RETRIEVAL_LIMIT, null);
    expect(mocks.threads).toHaveBeenCalledWith(expect.objectContaining({ queryEmbedding: null }));
  });
  it("keeps how each selected record was found for the turn's log", async () => {
    mocks.search.mockResolvedValue({
      claimIdsByConflictRef: new Map(), conflicts: [], relatedClaimIds: ["claim-1"],
      diagnostics: DIAGNOSTICS,
      results: [{
        evidence: { russianMorphologyRank: null, semanticSimilarity: null, simpleLexicalRank: 0.2 },
        memory: {
          author: { status: "current_member", telegramUserId: null, userId: null },
          confirmation: "model_high", content: "Код домофона 4271", createdAt: "2026-07-01T10:00:00.000Z",
          embeddingStatus: "indexed", id: "claim-1", kind: "fact",
          memoryRef: "mem_11111111111111111111111111111111", messageThreadId: null, scope: "family",
          sensitivity: "normal", source: "test:stages", updatedAt: "2026-07-01T10:00:00.000Z",
        },
        score: 0.016,
      }],
    });

    const context = await retrieveMemoryTurnContext({} as MemoryAuthorization, "4271", []);

    // A record only the exact branch found carries no similarity: the vector never vouched for it.
    expect(context.rankingByMemoryRef.get("mem_11111111111111111111111111111111")).toEqual({
      branches: ["simple"], fusedScore: 0.016, semanticSimilarity: null,
    });
  });

  it("carries the branch numbers of a successful turn together with the query's own", async () => {
    const context = await retrieveMemoryTurnContext({} as MemoryAuthorization, "private query", []);
    expect(context.diagnostics)
      .toMatchObject({ queryCharacters: "private query".length, queryChunks: 1, simpleMatched: 0 });
  });
});
