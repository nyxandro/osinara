/**
 * Where code, links and paragraphs are in a Markdown text, read the way Markdown defines it.
 *
 * Exports:
 * - `SourceRange`: a half-open range of source offsets.
 * - `readMarkdownTree`: the CommonMark and GFM syntax tree, every node with exact source offsets.
 * - `walkMarkdownTree`: visits every node of a tree, parents before children.
 * - `nodeRange`: the source range of one node.
 * - `markdownCodeRanges`: the ranges of fenced, indented and inline code.
 * - `trustedCodeRanges`: the code Telegram is sure to show as code, whose text may stay raw.
 * - `openTrailingFence`: the fence a text ends inside, if a truncated answer left one open.
 *
 * Key constructs:
 * - Telegram parses rich Markdown like GitHub Flavored Markdown. Guessing its structure with
 *   patterns kept missing cases a person never sees coming: a code span broken across two lines, a
 *   backtick inside a link address, a fence closed by the next list item. A real parser reads them
 *   as Telegram does, so the filter, the line breaks and the reply-button reader share one reading.
 * - The tree is for locating text only; nothing is rendered from it. The source text stays the
 *   message, and callers edit it by the offsets the tree gives.
 */
import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export interface SourceRange {
  readonly end: number;
  readonly start: number;
}

export function readMarkdownTree(markdown: string): Root {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

export function walkMarkdownTree(tree: Root, visit: (node: Nodes) => void): void {
  const pending: Nodes[] = [tree];
  while (pending.length > 0) {
    const node = pending.pop()!;
    visit(node);
    if ("children" in node) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index]!);
    }
  }
}

/** The parser places every node it reads; a node without a place is a parser contract break. */
export function nodeRange(node: Nodes): SourceRange {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new Error(`AGENT_MARKDOWN_POSITION_MISSING: ${node.type}`);
  }
  return { end, start };
}

/** Every code range the parser finds: text there is not Markdown. */
export function markdownCodeRanges(tree: Root): SourceRange[] {
  const ranges: SourceRange[] = [];
  walkMarkdownTree(tree, (node) => {
    if (node.type === "code" || node.type === "inlineCode") ranges.push(nodeRange(node));
  });
  return ranges.sort((left, right) => left.start - right.start);
}

const FENCE_OPENING_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;
const INLINE_BLOCK_TYPES = new Set(["heading", "paragraph", "tableCell"]);

/** Where a `$$` line opens a formula that may run over several lines, up to its closing line. */
function displayMathRegions(markdown: string): SourceRange[] {
  const regions: SourceRange[] = [];
  let open: number | null = null;
  let offset = 0;
  for (const line of markdown.split("\n")) {
    if (line.trim() === "$$") {
      if (open === null) open = offset;
      else {
        regions.push({ end: offset + line.length, start: open });
        open = null;
      }
    }
    offset += line.length + 1;
  }
  if (open !== null) regions.push({ end: markdown.length, start: open });
  return regions;
}

/**
 * The code whose raw text is safe to send. Telegram documents fenced code and inline code spans;
 * indented code it does not, so that counts as text. It also reads `$…$` and `$$` formulas, which
 * the parser does not, and a formula could take what the parser sees as the start of code:
 * - a fence that opens inside a possible multi-line `$$` formula is not trusted;
 * - an inline span is not trusted when a `$` stands before it in its paragraph, heading or cell,
 *   outside earlier spans: Markdown reads left to right, so only a formula opened earlier can
 *   take its backtick.
 * Text left out is escaped, which is safe under either reading.
 */
export function trustedCodeRanges(markdown: string, tree: Root): SourceRange[] {
  const ranges: SourceRange[] = [];
  const math = displayMathRegions(markdown);
  const visit = (node: Nodes, block: SourceRange | null, spans: SourceRange[]): void => {
    if (node.type === "code") {
      const range = nodeRange(node);
      const fenced = FENCE_OPENING_PATTERN.test(markdown.slice(range.start, range.end));
      if (fenced && !math.some((region) => range.start > region.start && range.start < region.end)) ranges.push(range);
      return;
    }
    if (node.type === "inlineCode") {
      const range = nodeRange(node);
      let before = block === null ? "$" : markdown.slice(block.start, range.start);
      for (const span of [...spans].reverse()) before = `${before.slice(0, span.start - block!.start)}${before.slice(span.end - block!.start)}`;
      if (!before.includes("$")) ranges.push(range);
      spans.push(range);
      return;
    }
    const inline = INLINE_BLOCK_TYPES.has(node.type);
    const inner = inline ? nodeRange(node) : block;
    const innerSpans = inline ? [] : spans;
    if ("children" in node) for (const child of node.children) visit(child, inner, innerSpans);
  };
  visit(tree, null, []);
  return ranges.sort((left, right) => left.start - right.start);
}

/**
 * The line that closes the fenced block a text ends inside, or null when it ends in none. The line
 * repeats what stands before the opening fence (a list indent, a quotation's `> `), so it closes
 * the block where it is instead of opening a new one.
 */
export function openTrailingFence(markdown: string, tree: Root): string | null {
  // The block a text ends with may sit in a list item or a quotation: follow the last children.
  let last: Nodes | undefined = tree;
  while (last !== undefined && last.type !== "code" && "children" in last) last = last.children.at(-1);
  if (last?.type !== "code" || nodeRange(last).end !== markdown.length) return null;
  const start = nodeRange(last).start;
  const source = markdown.slice(start);
  const opening = FENCE_OPENING_PATTERN.exec(source);
  if (opening === null) return null;
  const fence = opening[1]!;
  const lines = source.split("\n");
  const closing = lines.length > 1 ? lines.at(-1)!.replace(/^[\s>]*/u, "").trim() : "";
  if (closing.length >= fence.length && closing === fence[0]!.repeat(closing.length)) return null;
  // A quotation's `>` must repeat; a list marker must not, or the line would start a new item.
  const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
  const prefix = `${markdown.slice(lineStart, start)}${opening[0].slice(0, -fence.length)}`.replace(/[^>\s]/gu, " ");
  return `${prefix}${fence}`;
}
