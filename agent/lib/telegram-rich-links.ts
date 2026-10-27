/**
 * Links and media of model text that must not reach a person live in a Telegram rich message.
 *
 * Export:
 * - `neutralizeTelegramRichLinks`: turns links with an unsafe address, media and unsafe link
 *   definitions into plain text, reading them the way Markdown does.
 *
 * Key constructs:
 * - A person may open only http, https, mailto and tel links and anchors within the message. A
 *   `tg://` or `javascript:` address could start an action in Telegram behind a harmless caption,
 *   and the model may have copied it from a page that asked it to.
 * - Media would make Telegram fetch an address the model chose; it stays a plain link to it.
 * - A refused link becomes its caption and its address in parentheses: nothing is lost, nothing
 *   opens. A refused definition is escaped, so the references to it read as plain text.
 * - Raw HTML is not Markdown to the parser, yet Telegram reads Markdown inside some tags, so links
 *   and media there are found by pattern as a second line of defense. Code Telegram may not show
 *   as code (see `trustedCodeRanges`) is text to it, so its link syntax is broken outright.
 * - A change can alter how the rest of the text reads, so the text is read again until nothing is
 *   left to change. A text that keeps changing (deeply nested media, crafted on purpose) gets its
 *   link syntax broken everywhere instead: the answer still goes out, plainer, and nothing opens.
 *
 * Exports also `inertLinkSyntax`, that last resort, for the filter's own one.
 */
import type { Nodes } from "mdast";

import { nodeRange, readMarkdownTree, trustedCodeRanges, walkMarkdownTree, type SourceRange } from "./markdown-syntax.js";

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const IN_MESSAGE_ANCHOR_PATTERN = /^#[\p{L}\p{N}_.:-]+$/u;
// One pass settles a text; more passes only follow changes that made new links appear.
const MAX_PASSES = 8;
// The addresses GFM links bare: web ones (a `www.` one gets `http://`) and e-mail.
const GFM_BARE_ADDRESS_PATTERN = /^(?:https?:\/\/|mailto:)/iu;

interface Edit extends SourceRange {
  readonly text: string;
}

function safeAddress(url: string): boolean {
  if (IN_MESSAGE_ANCHOR_PATTERN.test(url)) return true;
  if (!URL.canParse(url)) return false;
  return ALLOWED_LINK_PROTOCOLS.has(new URL(url).protocol);
}

/**
 * Escapes the `!` of every media mark not escaped yet. An even run of backslashes before it
 * escapes only backslashes, so the mark is still live there.
 */
function escapeMediaMarks(markdown: string): string {
  return markdown.replace(/(\\*)!\[/gu, (mark, slashes: string) => slashes.length % 2 === 0 ? `${slashes}\\![` : mark);
}

/** Inline links inside raw HTML, found by pattern: Markdown does not parse them there. */
function neutralizePatternLinks(markdown: string): string {
  let result = "";
  let offset = 0;
  while (offset < markdown.length) {
    const labelStart = markdown.indexOf("[", offset);
    if (labelStart === -1) return result + markdown.slice(offset);
    const labelEnd = markdown.indexOf("](", labelStart + 1);
    // A line break may stand in a label or a destination; a blank line ends the paragraph.
    if (labelEnd === -1 || markdown.slice(labelStart + 1, labelEnd).includes("\n\n")) {
      result += markdown.slice(offset, labelStart + 1);
      offset = labelStart + 1;
      continue;
    }
    // Destinations may hold balanced parentheses, a title or leading spaces; the address is the
    // first word after the opening parenthesis, and everything up to the closing one goes with it.
    let depth = 1;
    let cursor = labelEnd + 2;
    for (; cursor < markdown.length && depth > 0; cursor += 1) {
      const character = markdown[cursor]!;
      if (character === "\\") {
        cursor += 1;
        continue;
      }
      if (character === "\n" && markdown[cursor + 1] === "\n") break;
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
    }
    if (depth !== 0) {
      result += markdown.slice(offset, labelStart + 1);
      offset = labelStart + 1;
      continue;
    }
    const label = markdown.slice(labelStart + 1, labelEnd);
    const destination = markdown.slice(labelEnd + 2, cursor - 1).trim();
    const address = destination.split(/\s/u)[0] ?? "";
    result += markdown.slice(offset, labelStart);
    result += safeAddress(address) ? markdown.slice(labelStart, cursor) : `${label} (${destination})`;
    offset = cursor;
  }
  return result;
}

/** A decoded address or caption put back as text: an entity the parser decoded must not open a tag. */
function literal(value: string): string {
  return value.replaceAll("<", "&lt;");
}

function captionOf(markdown: string, node: Nodes & { children: readonly Nodes[] }): string {
  const first = node.children[0];
  const last = node.children.at(-1);
  if (first === undefined || last === undefined) return "";
  return markdown.slice(nodeRange(first).start, nodeRange(last).end);
}

const CHANGED_TYPES = new Set(["code", "definition", "html", "image", "imageReference", "inlineCode", "link"]);

function editOf(markdown: string, node: Nodes, trusted: readonly SourceRange[]): Edit | null {
  if (!CHANGED_TYPES.has(node.type)) return null;
  if (node.position === undefined) {
    // GFM finds bare web and e-mail addresses after parsing, and the links it makes for them carry
    // no place in the text; by its own rule they are http, https or mailto.
    if (node.type === "link" && GFM_BARE_ADDRESS_PATTERN.test(node.url)) return null;
    throw new Error(`AGENT_MARKDOWN_POSITION_MISSING: ${node.type}`);
  }
  const range = nodeRange(node);
  const opening = markdown[range.start];
  switch (node.type) {
    case "link":
      // An autolink starts with `<` and goes dead with every other `<` of the text; a bare
      // address that GFM links is http, https or e-mail by its own rule.
      if (opening !== "[" || safeAddress(node.url)) return null;
      return { ...range, text: `${captionOf(markdown, node)} (${literal(node.url)})` };
    case "image":
      if (opening !== "!") return null;
      return safeAddress(node.url)
        ? { ...range, text: `\\${markdown.slice(range.start, range.end)}` }
        : { ...range, text: `${literal(node.alt ?? "")} (${literal(node.url)})` };
    case "imageReference":
      return opening === "!" ? { ...range, text: `\\${markdown.slice(range.start, range.end)}` } : null;
    case "definition":
      return safeAddress(node.url) ? null : { ...range, text: `\\${markdown.slice(range.start, range.end)}` };
    case "code":
    case "inlineCode": {
      if (trusted.some((code) => code.start === range.start && code.end === range.end)) return null;
      const source = markdown.slice(range.start, range.end);
      const inert = inertLinkSyntax(source);
      return inert === source ? null : { ...range, text: inert };
    }
    case "html": {
      const source = markdown.slice(range.start, range.end);
      // A definition there could serve a reference Telegram resolves in the Markdown after it.
      const neutralized = breakDefinitions(escapeMediaMarks(neutralizePatternLinks(source)));
      return neutralized === source ? null : { ...range, text: neutralized };
    }
    default:
      return null;
  }
}

/** The outermost changes of one reading; a change inside another waits for the next reading. */
function editsOf(markdown: string): Edit[] {
  const edits: Edit[] = [];
  const tree = readMarkdownTree(markdown);
  const trusted = trustedCodeRanges(markdown, tree);
  walkMarkdownTree(tree, (node) => {
    const edit = editOf(markdown, node, trusted);
    if (edit !== null) edits.push(edit);
  });
  edits.sort((left, right) => left.start - right.start);
  const outermost: Edit[] = [];
  for (const edit of edits) {
    const previous = outermost.at(-1);
    if (previous === undefined || edit.start >= previous.end) outermost.push(edit);
  }
  return outermost;
}

/** Escapes the `[` of every `[label]:`, even across a line break, so no definition is read. */
function breakDefinitions(markdown: string): string {
  return markdown.replace(/(\\*)\[([^\]]*)\]:/gu, (definition, slashes: string, label: string) =>
    slashes.length % 2 === 0 ? `${slashes}\\[${label}]:` : definition);
}

/**
 * No link, media or link definition survives this, wherever it stands: every bracket that could
 * open one is escaped.
 */
export function inertLinkSyntax(markdown: string): string {
  return markdown.replace(/(\\*)\[/gu, (bracket, slashes: string) => slashes.length % 2 === 0 ? `${slashes}\\[` : bracket);
}

export function neutralizeTelegramRichLinks(markdown: string): string {
  let text = markdown;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const edits = editsOf(text);
    if (edits.length === 0) return text;
    for (const edit of [...edits].reverse()) {
      text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
    }
  }
  console.error(JSON.stringify({ code: "AGENT_TELEGRAM_RICH_LINKS_UNSETTLED" }));
  return inertLinkSyntax(text);
}
