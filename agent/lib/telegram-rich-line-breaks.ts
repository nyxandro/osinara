/**
 * Line breaks of model text kept in a Telegram rich message.
 *
 * Export:
 * - `keepTelegramRichLineBreaks`: turns each line break inside a paragraph into a hard break.
 *
 * Key constructs:
 * - Telegram parses rich markdown like CommonMark: a single line break inside a paragraph is a soft
 *   break and shows as a space, so "Итог:\nМолоко — 100 ₽" reads as one line. A model writes the
 *   way a person types in a chat, where a new line is a new line.
 * - Two trailing spaces make a hard break. Telegram renders them exactly like `<br>` and a trailing
 *   backslash, which other bots verified with its "message is not modified" answer to an edit.
 * - Only paragraphs have soft breaks, and the parser knows exactly where each one is, including
 *   paragraphs of quotations and list items. Code, tables, headings, HTML blocks such as the frame
 *   of a collapsible block, and a paragraph holding a block formula are left exactly as written,
 *   and so is a line break inside a code span or an HTML tag, or one that already is a hard break.
 * - A Windows line ending is a line break like any other: left as it is, the carriage return would
 *   stand before the two spaces and turn every line into a paragraph of its own.
 */
import { markdownCodeRanges, nodeRange, readMarkdownTree, walkMarkdownTree, type SourceRange } from "./markdown-syntax.js";

const HARD_BREAK = "  ";
const ENDS_WITH_HARD_BREAK_PATTERN = /(?: {2,}|\\)$/u;
const MATH_FENCE_LINE_PATTERN = /^\s*\$\$\s*$/mu;

function inside(ranges: readonly SourceRange[], offset: number): boolean {
  return ranges.some((range) => offset > range.start && offset < range.end);
}

export function keepTelegramRichLineBreaks(markdown: string): string {
  const text = markdown.replace(/\r\n?/gu, "\n");
  const tree = readMarkdownTree(text);
  const verbatim = [...markdownCodeRanges(tree)];
  walkMarkdownTree(tree, (node) => {
    if (node.type === "html") verbatim.push(nodeRange(node));
  });
  const breaks: number[] = [];
  walkMarkdownTree(tree, (node) => {
    if (node.type !== "paragraph") return;
    const { end, start } = nodeRange(node);
    const source = text.slice(start, end);
    if (MATH_FENCE_LINE_PATTERN.test(source)) return;
    for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
      const lineEnd = start + index;
      const lineStart = text.lastIndexOf("\n", lineEnd - 1) + 1;
      if (inside(verbatim, lineEnd) || ENDS_WITH_HARD_BREAK_PATTERN.test(text.slice(lineStart, lineEnd))) continue;
      breaks.push(lineEnd);
    }
  });
  let kept = text;
  for (const offset of breaks.sort((left, right) => right - left)) {
    kept = `${kept.slice(0, offset)}${HARD_BREAK}${kept.slice(offset)}`;
  }
  return kept;
}
