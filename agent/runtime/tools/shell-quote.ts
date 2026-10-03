/**
 * Single-quotes a value for a POSIX shell command line.
 *
 * Ported from eve 0.40.0 `execution/sandbox/shell-quote.ts` (Apache-2.0, see NOTICE-eve).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
