/**
 * Retrieval result ranking and exact-duplicate collapse tests.
 *
 * Constructs covered:
 * - NFKC, lowercase, whitespace, and punctuation normalization identifies exact duplicates safely.
 * - Read-time collapse preserves the first representative only inside one scoped subject identity.
 */
import { describe, expect, it } from "vitest";

import type { ReferencedMemoryItem } from "./memory-record.js";
import {
  collapseExactDuplicateRetrievalResults,
  normalizeMemoryExactDuplicateKey,
  type ScoredMemoryRetrievalResult,
} from "./memory-retrieval-ranking.js";

function result(
  content: string,
  score: number,
  memoryRef: string,
  exactDuplicateIdentity = "personal:user-1:subject:user-1",
): ScoredMemoryRetrievalResult {
  const memory: ReferencedMemoryItem = {
    author: { status: "current_member", telegramUserId: "synthetic", userId: "synthetic" },
    confirmation: "user_confirmed",
    content,
    createdAt: "2026-07-01T10:00:00.000Z",
    embeddingStatus: "indexed",
    id: `internal-${memoryRef}`,
    kind: "fact",
    memoryRef,
    messageThreadId: null,
    scope: "personal",
    sensitivity: "normal",
    source: "test:retrieval-ranking",
    occurredAt: null,
    updatedAt: "2026-07-01T10:00:00.000Z",
  };
  return {
    exactDuplicateIdentity,
    evidence: {
      russianMorphologyRank: null,
      semanticSimilarity: 0.9,
      simpleLexicalRank: 0.1,
    },
    memory,
    retention: 1,
    score,
  };
}

describe("normalizeMemoryExactDuplicateKey", () => {
  it("normalizes Unicode compatibility forms, case, spaces, and punctuation", () => {
    expect(normalizeMemoryExactDuplicateKey("  ＹＤＥＸ, Цена: 4 250!!!\n"))
      .toBe(normalizeMemoryExactDuplicateKey("ydex цена 4 250"));
  });

  it("does not collapse words whose letters differ", () => {
    expect(normalizeMemoryExactDuplicateKey("термометр в ящике"))
      .not.toBe(normalizeMemoryExactDuplicateKey("барометр в ящике"));
  });
});

describe("collapseExactDuplicateRetrievalResults", () => {
  it("preserves the top-ranked representative and leaves stored DTOs unchanged", () => {
    const top = result("Врач рекомендует пить воду утром.", 0.04, "mem_11111111111111111111111111111111");
    const duplicate = result(" ВРАЧ рекомендует пить воду утром!!! ", 0.03, "mem_22222222222222222222222222222222");
    const distinct = result("Врач рекомендует пить чай вечером.", 0.02, "mem_33333333333333333333333333333333");
    const input = [top, duplicate, distinct];

    expect(collapseExactDuplicateRetrievalResults(input, 2)).toEqual([top, distinct]);
    expect(input).toEqual([top, duplicate, distinct]);
  });

  it("keeps equal text for different scoped subjects as independent claims", () => {
    const anna = result(
      "Любит улун",
      0.04,
      "mem_11111111111111111111111111111111",
      "family:family-1:subject:user-anna",
    );
    const petr = result(
      " любит улун! ",
      0.03,
      "mem_22222222222222222222222222222222",
      "family:family-1:subject:user-petr",
    );
    const externalAnna = result(
      "ЛЮБИТ УЛУН",
      0.02,
      "mem_33333333333333333333333333333333",
      "group:group-1:subject:participant-anna",
    );

    expect(collapseExactDuplicateRetrievalResults([anna, petr, externalAnna], 3))
      .toEqual([anna, petr, externalAnna]);
  });

  it("keeps equal subject text from different provenance identities", () => {
    const anna = result(
      "Пётр предпочитает улун",
      0.04,
      "mem_11111111111111111111111111111111",
      "family:family-1:subject:petr:source:anna",
    );
    const maria = result(
      "ПЁТР ПРЕДПОЧИТАЕТ УЛУН!",
      0.03,
      "mem_22222222222222222222222222222222",
      "family:family-1:subject:petr:source:maria",
    );

    expect(collapseExactDuplicateRetrievalResults([anna, maria], 2)).toEqual([anna, maria]);
  });
});
