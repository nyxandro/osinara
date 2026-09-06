/**
 * Internal memory retrieval scoring and exact-duplicate collapse contracts.
 *
 * Exports:
 * - `MemoryRetrievalBranchEvidence`: threshold-qualified evidence from each active branch.
 * - `ScoredMemoryRetrievalResult`: internal diagnostic DTO that never crosses the model boundary.
 * - `normalizeMemoryExactDuplicateKey`: safe exact-read normalization key.
 * - `collapseExactDuplicateRetrievalResults`: preserves top-ranked representatives without writes.
 */
import type { ReferencedMemoryItem } from "./memory-record.js";
import type { ModelMemoryEvidence } from "./model-memory.js";

export interface MemoryRetrievalBranchEvidence {
  russianMorphologyRank: number | null;
  semanticSimilarity: number | null;
  simpleLexicalRank: number | null;
}

export interface ScoredMemoryRetrievalResult {
  evidence: MemoryRetrievalBranchEvidence;
  exactDuplicateIdentity: string;
  memory: ReferencedMemoryItem;
  /** exp(-age / S) in [0, 1]; the automatic turn block admits only retained records. */
  retention: number;
  sourceEvidence?: ModelMemoryEvidence;
  score: number;
}

export function normalizeMemoryExactDuplicateKey(content: string): string {
  // NFKC folds compatibility forms; punctuation becomes a boundary instead of joining words.
  return content
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function collapseExactDuplicateRetrievalResults(
  rankedResults: readonly ScoredMemoryRetrievalResult[],
  limit: number,
): ScoredMemoryRetrievalResult[] {
  const seen = new Set<string>();
  const unique: ScoredMemoryRetrievalResult[] = [];

  // Equal wording belongs to one read cluster only inside the same trust-zone and subject identity.
  for (const result of rankedResults) {
    const duplicateKey = `${result.exactDuplicateIdentity}\u0000${
      normalizeMemoryExactDuplicateKey(result.memory.content)
    }`;
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    unique.push(result);
    if (unique.length === limit) break;
  }
  return unique;
}
