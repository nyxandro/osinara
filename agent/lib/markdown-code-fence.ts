/**
 * Which lines of a Markdown answer are literal code and must be left exactly as written.
 *
 * Exports:
 * - `FenceState`: an open fenced block, or `null` when the walk is in ordinary text.
 * - `nextFenceState`: the state after reading one line.
 * - `isIndentedCodeLine`: a line indented far enough to be code on its own.
 *
 * Transport directives are recognized by shape, and every shape a directive can take is also
 * something a person may legitimately ask about. A line that only looks like transport because it
 * sits inside an example must survive untouched, so every walk over an answer shares this one
 * reading of where code begins and ends rather than keeping its own copy of the rules.
 */
const FENCE_LINE_PATTERN = /^ {0,3}(?<fence>`{3,}|~{3,})(?<info>.*)$/u;
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/u;

export interface FenceState {
  character: string;
  length: number;
}

export function nextFenceState(line: string, open: FenceState | null): FenceState | null {
  const match = FENCE_LINE_PATTERN.exec(line);
  if (!match) return open;
  const fence = match.groups?.fence ?? "";
  const info = match.groups?.info ?? "";
  const character = fence[0] ?? "";
  // A closing fence repeats the opening character, is at least as long, and carries no info string.
  if (open) {
    const closes = character === open.character && fence.length >= open.length &&
      info.trim().length === 0;
    return closes ? null : open;
  }
  // Markdown forbids a backtick inside the info string of a backtick fence.
  if (character === "`" && info.includes("`")) return null;
  return { character, length: fence.length };
}

export function isIndentedCodeLine(line: string): boolean {
  return INDENTED_CODE_PATTERN.test(line);
}
