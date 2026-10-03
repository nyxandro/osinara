/**
 * Single-quotes a value for a POSIX shell command line.
 *
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
