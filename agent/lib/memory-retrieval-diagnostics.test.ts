/**
 * Retrieval diagnostics boundary tests.
 *
 * Constructs covered:
 * - Repository scores, branch evidence, database IDs, and identity metadata remain internal.
 * - Turn-level retrieval returns only the explicit model-safe memory DTO.
 * - Log-only retrieval diagnostics stay beside the memories and never enter them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { embedQuery, searchWithConflictClosure } = vi.hoisted(() => ({
  embedQuery: vi.fn(),
  searchWithConflictClosure: vi.fn(),
}));

vi.mock("./memory-embedding-client.js", () => ({ embedMemoryQueryChunks: embedQuery }));
vi.mock("./memory-retrieval-repository.js", () => ({
  memoryRetrievalRepository: { searchWithConflictClosure },
}));

import { retrieveRelevantMemories } from "./memory-retrieval.js";

describe("retrieval diagnostics boundary", () => {
  beforeEach(() => {
    embedQuery.mockReset().mockResolvedValue([[1, 0]]);
    searchWithConflictClosure.mockReset().mockResolvedValue({ conflicts: [], diagnostics: {
      candidateLimitHit: false,
      russianQualified: 1,
      russianMatched: 1,
      russianTopRank: 0.1,
      semanticQualified: 1,
      semanticMatched: 4,
      semanticTopSimilarity: 0.83,
      simpleQualified: 0,
      simpleMatched: 2,
      simpleTopRank: 0.01,
    }, results: [{
      evidence: {
        russianMorphologyRank: 0.1,
        semanticSimilarity: 0.83,
        simpleLexicalRank: null,
      },
      memory: {
        author: {
          status: "current_member",
          telegramUserId: "synthetic-telegram-id",
          userId: "00000000-0000-4000-8000-000000000001",
        },
        confirmation: "user_confirmed",
        content: "Синтетический факт",
        createdAt: "2026-07-01T10:00:00.000Z",
        embeddingStatus: "indexed",
        id: "00000000-0000-4000-8000-000000000002",
        kind: "fact",
        memoryRef: "mem_11111111111111111111111111111111",
        messageThreadId: null,
        scope: "personal",
        sensitivity: "normal",
        source: "test:diagnostics",
        updatedAt: "2026-07-01T10:00:00.000Z",
      },
      score: 0.034,
    }] });
  });

  it("projects scored internal results through the model allowlist", async () => {
    const result = await retrieveRelevantMemories({
      familyId: "00000000-0000-4000-8000-000000000003",
      groupId: null,
      role: "owner",
      scopes: ["personal"],
      telegramActorId: "synthetic-telegram-id",
      telegramActorKind: "telegram_user",
      telegramUserId: "synthetic-telegram-id",
      userId: "00000000-0000-4000-8000-000000000001",
    }, "синтетический запрос");

    expect(result.memories).toEqual([{
      authorStatus: "current_member",
      confirmation: "user_confirmed",
      content: "Синтетический факт",
      createdAt: "2026-07-01T10:00:00.000Z",
      kind: "fact",
      memoryRef: "mem_11111111111111111111111111111111",
      scope: "personal",
      sensitivity: "normal",
    }]);
    expect(JSON.stringify(result.memories)).not.toMatch(
      /score|evidence|Similarity|Rank|00000000-0000-4000-8000-00000000000[12]/u,
    );
  });

  it("measures the query as numbers only, beside the memories rather than inside them", async () => {
    const result = await retrieveRelevantMemories({
      familyId: "00000000-0000-4000-8000-000000000003",
      groupId: null,
      role: "owner",
      scopes: ["personal"],
      telegramActorId: "synthetic-telegram-id",
      telegramActorKind: "telegram_user",
      telegramUserId: "synthetic-telegram-id",
      userId: "00000000-0000-4000-8000-000000000001",
    }, "синтетический запрос");

    expect(result.diagnostics).toEqual({
      candidateLimitHit: false,
      queryCharacters: "синтетический запрос".length,
      queryChunks: 1,
      russianQualified: 1,
      russianMatched: 1,
      russianTopRank: 0.1,
      semanticQualified: 1,
      semanticMatched: 4,
      semanticTopSimilarity: 0.83,
      simpleQualified: 0,
      simpleMatched: 2,
      simpleTopRank: 0.01,
    });
    // Every diagnostic value is a number or a boolean: no query text can leak through this DTO.
    expect(Object.values(result.diagnostics).every((value) =>
      value === null || typeof value === "number" || typeof value === "boolean"
    )).toBe(true);
  });
});
