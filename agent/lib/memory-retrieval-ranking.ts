/**
 * Internal memory retrieval scoring and exact-duplicate collapse contracts.
 *
 * Exports:
 * - `MemoryRetrievalBranchEvidence`: threshold-qualified evidence from each active branch.
 * - `MemoryRetrievalBranchDiagnostics`: log-only per-branch counts and pre-threshold best scores.
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

/**
 * Numbers about one search, for logs only. Each branch reports three things, and all three are
 * needed to calibrate a gate:
 *
 * - `*Matched` — what the branch found before its own threshold. For the word branches this is the
 *   number the whole `AND` question turns on: zero means the query matched nothing at all. For the
 *   semantic branch it is every indexed record the viewer may read, by construction — a denominator
 *   rather than a signal, and it drops only when indexing itself is broken.
 * - `*Qualified` — what passed the threshold, counted before the candidate limit. Together with
 *   `*Matched` this says how much the gate cut, which is the one thing a log needs to recalibrate
 *   it; capped at the limit it would hide exactly that.
 * - `*TopRank` / `*TopSimilarity` — the best score the branch saw, also before the threshold.
 *
 * Nothing here is derived from record text, which keeps the observability boundary intact.
 */
export interface MemoryRetrievalBranchDiagnostics {
  candidateLimitHit: boolean;
  russianMatched: number;
  russianQualified: number;
  russianTopRank: number | null;
  semanticMatched: number;
  semanticQualified: number;
  semanticTopSimilarity: number | null;
  simpleMatched: number;
  simpleQualified: number;
  simpleTopRank: number | null;
}

export interface ScoredMemoryRetrievalResult {
  evidence: MemoryRetrievalBranchEvidence;
  exactDuplicateIdentity: string;
  memory: ReferencedMemoryItem;
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
