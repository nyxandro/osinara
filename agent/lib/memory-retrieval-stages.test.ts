import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryAuthorization } from "./memory-context.js";
import { AppError } from "./app-error.js";
const mocks = vi.hoisted(() => ({ embedding: vi.fn(), search: vi.fn(), threads: vi.fn() }));
vi.mock("./memory-embedding-client.js", () => ({
  embedMemoryQueryChunks: mocks.embedding,
  memoryQueryCentroid: (vectors: readonly (readonly number[])[]) => [...vectors[0]!],
}));
vi.mock("./memory-retrieval-repository.js", () => ({ memoryRetrievalRepository: { searchWithConflictClosure: mocks.search } }));
vi.mock("./memory-thread-brief-repository.js", () => ({ memoryThreadBriefRepository: { activate: mocks.threads } }));
import { retrieveMemoryTurnContext } from "./memory-retrieval.js";
import { memoryFailureCode } from "./memory-context-failure.js";

describe("memory retrieval failure provenance", () => {
  beforeEach(() => {
    mocks.embedding.mockReset().mockResolvedValue([[1]]);
    mocks.search.mockReset().mockResolvedValue({
      conflicts: [], relatedClaimIds: [], results: [],
      diagnostics: {
        candidateLimitHit: false,
        recentlyShown: 0,
        russianQualified: 0, russianMatched: 0, russianTopRank: null,
        semanticQualified: 0, semanticMatched: 0, semanticTopSimilarity: null,
        simpleQualified: 0, simpleMatched: 0, simpleTopRank: null,
      },
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
    expect(mocks.search).toHaveBeenCalledWith({}, "private query", [], undefined, null);
    expect(mocks.threads).toHaveBeenCalledWith(expect.objectContaining({ queryEmbedding: null }));
  });
  it("carries the branch numbers of a successful turn together with the query's own", async () => {
    const context = await retrieveMemoryTurnContext({} as MemoryAuthorization, "private query", []);
    expect(context.diagnostics)
      .toMatchObject({ queryCharacters: "private query".length, queryChunks: 1, simpleMatched: 0 });
  });
});
