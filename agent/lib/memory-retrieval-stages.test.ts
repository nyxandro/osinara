import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryAuthorization } from "./memory-context.js";
import { AppError } from "./app-error.js";
const mocks = vi.hoisted(() => ({ embedding: vi.fn(), search: vi.fn(), threads: vi.fn() }));
vi.mock("./memory-embedding-client.js", () => ({ embedMemoryQuery: mocks.embedding }));
vi.mock("./memory-retrieval-repository.js", () => ({ memoryRetrievalRepository: { searchWithConflictClosure: mocks.search } }));
vi.mock("./memory-thread-brief-repository.js", () => ({ memoryThreadBriefRepository: { activate: mocks.threads } }));
import { retrieveMemoryTurnContext } from "./memory-retrieval.js";
import { memoryFailureCode } from "./memory-context-failure.js";

describe("memory retrieval failure provenance", () => {
  beforeEach(() => {
    mocks.embedding.mockReset().mockResolvedValue([1]);
    mocks.search.mockReset().mockResolvedValue({ results: [], conflicts: [], relatedClaimIds: [] });
    mocks.threads.mockReset().mockResolvedValue({ threads: [], totalCharacters: 0 });
  });
  it.each(["embedding", "search", "threads"] as const)("keeps the original %s failure and never continues to later stages", async phase => {
    const failure = new AppError("AGENT_TEST_DEPENDENCY_FAILED", "Причина отказа");
    mocks[phase].mockRejectedValue(failure);
    const result = retrieveMemoryTurnContext({} as MemoryAuthorization, "private query", []);
    await expect(result).rejects.toMatchObject({ phase, cause: failure });
    await result.catch(error => expect(memoryFailureCode(error)).toBe("AGENT_TEST_DEPENDENCY_FAILED"));
    if (phase === "embedding") expect(mocks.search).not.toHaveBeenCalled();
    if (phase !== "threads") expect(mocks.threads).not.toHaveBeenCalled();
  });
});
