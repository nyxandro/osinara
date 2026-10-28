/**
 * Files the model places in its final answer, read the way Markdown reads them.
 *
 * Exports:
 * - `AnswerFileReference`: one `![caption](/workspace/<scope>/<path>)` with its place in the text.
 * - `AnswerMediaReading`: the files, the other media addresses and the unread workspace paths.
 * - `readAnswerMedia`: finds them outside code with the shared Markdown parser.
 * - `layOutAnswerFiles`: puts every file in a block of its own, where Telegram accepts media.
 *
 * Key constructs:
 * - The address is the path the agent sees in its sandbox. The parser percent-encodes non-ASCII and
 *   bracketed paths, so the path is decoded back to what the model wrote.
 * - Telegram takes media only as a separate block. A block of files alone is replaced in place; a
 *   file anywhere else (a sentence, a list, a quote, a table) is cut out and follows the top-level
 *   block it stood in, in the order written, so a misplaced file needs no correction round.
 * - A container the file alone filled (a list item, a heading, a quote, an emphasis) leaves with it:
 *   a bare `-` under a line would turn that line into a heading.
 * - A `](/workspace/` Markdown did not read as media (a space in the path, a plain link, raw HTML
 *   around it) is counted, so the answer check can name it instead of the user seeing a raw path.
 */
import type { Nodes, Root, RootContent } from "mdast";

import type { WorkspaceScope } from "../workspaces/workspace-file-record.js";
import {
  markdownCodeRanges,
  nodeRange,
  readMarkdownTree,
  type SourceRange,
} from "../markdown-syntax.js";

export interface AnswerFileReference {
  /** Title when given, else the bracket text, on one line; empty when the model wrote neither. */
  readonly caption: string;
  /** The path inside the scope, as the model wrote it. */
  readonly path: string;
  readonly range: SourceRange;
  readonly scope: WorkspaceScope;
}

export interface AnswerMediaReading {
  readonly files: readonly AnswerFileReference[];
  /** Media addresses that are not a workspace file: web media and any other address. */
  readonly foreign: ReadonlyArray<{ readonly address: string; readonly remote: boolean }>;
  /** Workspace paths in link syntax that Markdown did not read as media. */
  readonly unread: number;
}

const WORKSPACE_FILE_ADDRESS_PATTERN = /^\/workspace\/(personal|family|group)\/(.+)$/u;
const REMOTE_ADDRESS_PATTERN = /^https?:\/\//iu;
const WORKSPACE_LINK_PATTERN = /\]\(\s*<?\/workspace\//gu;
const HORIZONTAL_SPACE_PATTERN = /[ \t]/u;

function decodedAddress(url: string): string | null {
  try {
    return decodeURIComponent(url);
  } catch {
    // A malformed escape is no path a file could have; the caller reports it as another address.
    return null;
  }
}

function captionOf(node: { readonly alt?: string | null; readonly title?: string | null }): string {
  const title = node.title?.trim() ?? "";
  return (title.length > 0 ? title : node.alt ?? "").replace(/\s+/gu, " ").trim();
}

function imagesUnder(node: Nodes): Array<Extract<Nodes, { type: "image" }>> {
  const images: Array<Extract<Nodes, { type: "image" }>> = [];
  const pending: Nodes[] = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.type === "image") images.push(current);
    if ("children" in current) {
      for (let index = current.children.length - 1; index >= 0; index -= 1) pending.push(current.children[index]!);
    }
  }
  return images;
}

function inside(position: number, ranges: readonly SourceRange[]): boolean {
  return ranges.some((range) => position >= range.start && position < range.end);
}

export function readAnswerMedia(markdown: string): AnswerMediaReading {
  const tree = readMarkdownTree(markdown);
  const files: AnswerFileReference[] = [];
  const foreign: Array<{ address: string; remote: boolean }> = [];
  const imageRanges: SourceRange[] = [];
  for (const image of imagesUnder(tree)) {
    const range = nodeRange(image);
    imageRanges.push(range);
    const address = decodedAddress(image.url);
    const match = address === null ? null : WORKSPACE_FILE_ADDRESS_PATTERN.exec(address);
    if (match) {
      files.push({ caption: captionOf(image), path: match[2]!, range, scope: match[1] as WorkspaceScope });
      continue;
    }
    foreign.push({ address: address ?? image.url, remote: REMOTE_ADDRESS_PATTERN.test(image.url) });
  }
  files.sort((left, right) => left.range.start - right.range.start);
  const skipped = [...markdownCodeRanges(tree), ...imageRanges];
  let unread = 0;
  for (const found of markdown.matchAll(WORKSPACE_LINK_PATTERN)) {
    if (!inside(found.index, skipped)) unread += 1;
  }
  return { files, foreign, unread };
}

// Containers a file may leave empty: they go with it rather than stay behind as a bare `-`, `#` or `>`.
const REMOVABLE_TYPES: ReadonlySet<string> = new Set([
  "blockquote", "delete", "emphasis", "heading", "link", "list", "listItem", "paragraph", "strong",
]);
const LINE_TYPES: ReadonlySet<string> = new Set(["blockquote", "heading", "list", "listItem", "paragraph"]);

/** Whether a node shows nothing but files: once they leave, it would stand empty. */
function onlyFiles(node: Nodes, fileStarts: ReadonlySet<number>): boolean {
  if (node.type === "image") return fileStarts.has(nodeRange(node).start);
  if (node.type === "text") return node.value.trim().length === 0;
  if (node.type === "break") return true;
  if (!REMOVABLE_TYPES.has(node.type) || !("children" in node) || node.children.length === 0) return false;
  return node.children.every((child) => onlyFiles(child, fileStarts));
}

/** The nodes from `node` down to the image that starts at `start`, both included. */
function pathTo(node: Nodes, start: number): Nodes[] | null {
  if (node.type === "image") return nodeRange(node).start === start ? [node] : null;
  if (!("children" in node)) return null;
  for (const child of node.children) {
    const range = nodeRange(child);
    if (start < range.start || start >= range.end) continue;
    const path = pathTo(child, start);
    if (path !== null) return [node, ...path];
  }
  return null;
}

/** What leaves the block with a file: the largest node below the block that only that file filled. */
function cutFor(block: RootContent, file: AnswerFileReference, fileStarts: ReadonlySet<number>): Nodes {
  const path = pathTo(block, file.range.start)!;
  return path.slice(1).find((node) => onlyFiles(node, fileStarts))!;
}

/** The range a cut removes: a line-level node takes its line break, an inline one a doubled space. */
function cutRange(markdown: string, block: SourceRange, cut: Nodes): SourceRange {
  let { end, start } = nodeRange(cut);
  if (LINE_TYPES.has(cut.type)) {
    while (start > block.start && HORIZONTAL_SPACE_PATTERN.test(markdown[start - 1]!)) start -= 1;
    if (end < block.end && markdown[end] === "\n") return { end: end + 1, start };
    return start > block.start && markdown[start - 1] === "\n" ? { end, start: start - 1 } : { end, start };
  }
  const next = markdown[end];
  if (next === undefined || end >= block.end || next === "\n") {
    while (start > block.start && HORIZONTAL_SPACE_PATTERN.test(markdown[start - 1]!)) start -= 1;
  } else if (HORIZONTAL_SPACE_PATTERN.test(next) && (start === block.start || HORIZONTAL_SPACE_PATTERN.test(markdown[start - 1]!))) {
    while (end < block.end && HORIZONTAL_SPACE_PATTERN.test(markdown[end]!)) end += 1;
  }
  return { end, start };
}

/** The block's text without its files and the containers they alone filled. */
function withoutFiles(markdown: string, block: RootContent, files: readonly AnswerFileReference[], fileStarts: ReadonlySet<number>): string {
  const range = nodeRange(block);
  const cuts = new Map<number, SourceRange>();
  for (const file of files) {
    const cut = cutRange(markdown, range, cutFor(block, file, fileStarts));
    cuts.set(cut.start, cut);
  }
  let text = "";
  let cursor = range.start;
  for (const cut of [...cuts.values()].sort((left, right) => left.start - right.start)) {
    if (cut.start < cursor) continue;
    text += markdown.slice(cursor, cut.start);
    cursor = cut.end;
  }
  return text + markdown.slice(cursor, range.end);
}

export function layOutAnswerFiles(
  markdown: string,
  files: readonly AnswerFileReference[],
  replacement: (file: AnswerFileReference, index: number) => string,
): string {
  if (files.length === 0) return markdown;
  const tree: Root = readMarkdownTree(markdown);
  const fileStarts = new Set(files.map((file) => file.range.start));
  const indexOf = new Map(files.map((file, index) => [file.range.start, index]));
  let output = "";
  let cursor = 0;
  for (const block of tree.children) {
    const range = nodeRange(block);
    const placed = files.filter((file) => file.range.start >= range.start && file.range.end <= range.end);
    if (placed.length === 0) continue;
    const blocks = placed.map((file) => replacement(file, indexOf.get(file.range.start)!)).join("\n\n");
    output += markdown.slice(cursor, range.start);
    if (onlyFiles(block, fileStarts)) {
      // A file block starts after a blank line, never as a lazy continuation of the line before.
      output = output.replace(/\s+$/u, "");
      output += output.length === 0 ? blocks : `\n\n${blocks}`;
    } else {
      output += `${withoutFiles(markdown, block, placed, fileStarts)}\n\n${blocks}`;
    }
    cursor = range.end;
    // What follows starts a block of its own, never a lazy continuation of the last file.
    const leading = /^\n*/u.exec(markdown.slice(cursor))![0].length;
    if (cursor + leading < markdown.length) {
      output += "\n\n";
      cursor += leading;
    }
  }
  return output + markdown.slice(cursor);
}
