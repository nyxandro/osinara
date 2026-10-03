/**
 * Rough token estimate: serialized JSON length / 4. Good enough to decide whether compaction is
 * needed; the real count comes back from the provider after each step.
 *
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
export function estimateTokens(value: unknown): number {
  return JSON.stringify(value).length / 4;
}
