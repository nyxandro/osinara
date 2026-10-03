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
 * - `*Matched` — what the branch found before its own threshold: zero means not one word of the
 *   question appears in any record the viewer may read. For the semantic branch it is how many
 *   records the nearest-chunk lookup reached, which is bounded by the candidate limit rather than
 *   by the corpus, and falls below it only when the viewer's memory holds fewer records than that.
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
  /** Records the last few turns of this conversation already put in front of the model. */
  recentlyShown: number;
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
