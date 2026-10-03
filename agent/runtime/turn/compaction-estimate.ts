/**
 * Rough token estimate: serialized JSON length / 4. Good enough to decide whether compaction is
 * needed; the real count comes back from the provider after each step.
 *
 * Ported from eve 0.40.0 `harness/token-estimate.ts` (Apache-2.0, see NOTICE-eve).
 */
export function estimateTokens(value: unknown): number {
  return JSON.stringify(value).length / 4;
}
