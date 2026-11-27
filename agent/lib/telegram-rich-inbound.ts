/**
 * Inbound Telegram rich message flattening.
 *
 * Exports:
 * - `telegramRichMessageText`: plain text a person reads in a Bot API `RichMessage`.
 * - `telegramRichQuoteText`: plain text of a fragment highlighted in a rich message.
 *
 * Key constructs:
 * - `RichText` is recursive: a string, an array, or a typed wrapper around another `RichText`.
 * - Only declared text containers are traversed, so block types, ids and URLs never become content.
 * - Telegram delivers no `text`/`caption` alongside a rich message, so this is the only reading of it.
 */

const BLOCK_SEPARATOR = "\n\n";

// A rich block carries its text in one of these fields; everything else is structure or media.
interface RichBlockLike {
  blocks?: unknown;
  caption?: unknown;
  cells?: unknown;
  items?: unknown;
  summary?: unknown;
  text?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** `RichText` is a string, an array of `RichText`, or a typed node wrapping more `RichText`. */
function richText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richText).join("");
  const node = record(value);
  if (node === null) return "";
  // A formula and a custom emoji carry their text in their own fields, not in `text`.
  if (node.type === "mathematical_expression" && typeof node.expression === "string") return node.expression;
  if (node.type === "custom_emoji" && typeof node.alternative_text === "string") return node.alternative_text;
  return richText(node.text);
}

function nonEmpty(value: string): string | null {
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function joinLines(parts: readonly (string | null)[], separator: string): string | null {
  return nonEmpty(parts.filter((part): part is string => part !== null).join(separator));
}

function listItem(value: unknown): string | null {
  const item = record(value);
  if (item === null) return null;
  const content = blockList(item.blocks, " ");
  const label = typeof item.label === "string" ? item.label.trim() : "";
  if (content === null) return nonEmpty(label);
  return nonEmpty(label.length > 0 ? `${label} ${content}` : content);
}

function tableRow(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return joinLines(value.map((cell) => nonEmpty(richText(record(cell)?.text))), " | ");
}

/** A caption keeps its credit, because the person reading the chat sees both lines. */
function caption(value: unknown): string | null {
  const node = record(value);
  if (node === null) return null;
  return joinLines([nonEmpty(richText(node.text)), nonEmpty(richText(node.credit))], "\n");
}

function block(value: unknown): string | null {
  const node = record(value) as RichBlockLike | null;
  if (node === null) return null;

  // A details block is read in full: its summary is visible, and hiding content must not hide it
  // from the agent, which sees the conversation as text rather than as a collapsible widget.
  if (node.summary !== undefined || node.blocks !== undefined) {
    return joinLines([
      nonEmpty(richText(node.summary)),
      blockList(node.blocks, BLOCK_SEPARATOR),
    ], BLOCK_SEPARATOR);
  }
  if (Array.isArray(node.items)) {
    return joinLines(node.items.map(listItem), "\n");
  }
  if (Array.isArray(node.cells)) {
    return joinLines(node.cells.map(tableRow), "\n");
  }
  if (node.text !== undefined) return nonEmpty(richText(node.text));
  return caption(node.caption);
}

function blockList(value: unknown, separator: string): string | null {
  if (!Array.isArray(value)) return null;
  return joinLines(value.map(block), separator);
}

/**
 * Returns the readable text of an inbound `RichMessage`, or `null` when it carries none.
 * A media-only rich message has no text at all and must stay indistinguishable from other media.
 */
export function telegramRichMessageText(value: unknown): string | null {
  const message = record(value);
  if (message === null) return null;
  return blockList(message.blocks, BLOCK_SEPARATOR);
}

/**
 * Returns the fragment a person highlighted in a rich message (`TextQuote.rich_texts`, Bot API 10.4),
 * or `null` when it carries no readable text. Each item is one quotable text of the message, and
 * Telegram itself joins them with line feeds when it counts the quote position.
 */
export function telegramRichQuoteText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return joinLines(value.map((part) => nonEmpty(richText(part))), "\n");
}
