/**
 * Deterministic Telegram final-presentation selection.
 *
 * Exports:
 * - `TelegramChunkPacing`: whether a chunk opens an authored aside or continues immediately.
 * - `TelegramFinalPresentationChunk`: one plain or rich provider-sized delivery unit.
 * - `TelegramFinalPresentationOptions`: what the answer carries besides its text.
 * - `formatTelegramFinalPresentation`: selects plain text unless supported markup is present.
 *
 * Key construct:
 * - Transport selection depends on authored syntax, not message length or a hidden default.
 * - An authored aside is a separate paced message; a length-driven split never is.
 * - Every authored message passes the length policy on its own.
 * - Reply buttons exist only in a rich message, so an answer carrying them ends in one. Text that
 *   would have gone plain stays literal there, line breaks included, and the question the buttons
 *   answer is kept below a generated accordion rather than hidden inside it.
 * - Model-authored formatting must not cost the answer: a message a rich message cannot hold (an
 *   over-wide table, too deep nesting, one indivisible block over the size limit) goes out as the
 *   text the model wrote, the way plain text does.
 */
import { splitTelegramMessageText } from "../runtime/telegram/api.js";

import { AppError } from "./app-error.js";
import {
  formatTelegramRichMessages,
  hasTelegramRichDetailsBlock,
} from "./telegram-rich-markdown.js";
import { openTrailingFence, readMarkdownTree } from "./markdown-syntax.js";
import { splitTelegramAuthoredParts } from "./telegram-authored-split.js";
import { literalRichParagraphs } from "./telegram-rich-literal.js";

export type TelegramChunkPacing = "aside" | "immediate";

export interface TelegramFinalPresentationOptions {
  /** Reply buttons go out under the last message of the answer. */
  readonly replyButtons?: boolean;
}

export interface TelegramFinalPresentationChunk {
  readonly format: "plain" | "rich";
  readonly pacing: TelegramChunkPacing;
  readonly text: string;
}

const RICH_BLOCK_PATTERN = /(?:^|\n)(?:#{2,3}\s|>\s|[-+*]\s|\d+\.\s|- \[[ xX]\]\s|```|\$\$\s*$|---\s*$|\|[^\n]*\|\s*$)/mu;
const GFM_TABLE_DELIMITER_PATTERN = /(?:^|\n)\s*:?-{3,}:?\s*\|\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*(?:$|\n)/mu;
const RICH_INLINE_PATTERN = /(?:\*\*[^*\n]+\*\*|~~[^~\n]+~~|==[^=\n]+==|\|\|[^|\n]+\|\||`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|<(?:details(?:\s+open)?|summary|u|ins|sub|sup)>|<\/(?:details|summary|u|ins|sub|sup)>)/iu;
const RICH_ITALIC_PATTERN = /(?:^|[^\p{L}\p{N}_])(?:\*[^*\n]+\*|_[^_\n]+_)(?=$|[^\p{L}\p{N}_])/u;
const RICH_MATH_PATTERN = /\$(?:[\\\p{L}][^$\n]*|[^$\n]*[=+*/^_-][^$\n]*)\$(?![\p{L}\p{N}])/u;
const LONG_ANSWER_MAX_CHARACTERS = 600;
const LONG_ANSWER_MAX_LINES = 7;
const LONG_ANSWER_MAX_LIST_ITEMS = 5;
const LONG_ANSWER_MAX_PARAGRAPHS = 2;
const LONG_ANSWER_LEAD_MAX_CHARACTERS = 240;
const LONG_ANSWER_SUMMARY = "Полный ответ";
const RICH_LIMIT_ERROR_CODES = new Set([
  "AGENT_TELEGRAM_RICH_BLOCK_TOO_LONG",
  "AGENT_TELEGRAM_RICH_NESTING_TOO_DEEP",
  "AGENT_TELEGRAM_RICH_TABLE_TOO_WIDE",
]);

function usesSupportedRichBlockFormatting(markdown: string): boolean {
  return RICH_BLOCK_PATTERN.test(markdown) || GFM_TABLE_DELIMITER_PATTERN.test(markdown);
}

function usesSupportedRichFormatting(markdown: string): boolean {
  return usesSupportedRichBlockFormatting(markdown) ||
    RICH_INLINE_PATTERN.test(markdown) ||
    RICH_ITALIC_PATTERN.test(markdown) ||
    RICH_MATH_PATTERN.test(markdown);
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function isLongAnswer(markdown: string): boolean {
  const lines = markdown.split("\n");
  const paragraphs = markdown.split(/\n\s*\n/gu).filter((part) => part.trim().length > 0);
  const listItems = lines.filter((line) => /^\s*(?:[-+*]|\d+\.)\s/u.test(line)).length;
  const structuredBlock = /(?:^|\n)```/u.test(markdown) ||
    /(?:^|\n)\|[^\n]*\|\s*$/mu.test(markdown) ||
    GFM_TABLE_DELIMITER_PATTERN.test(markdown);
  return characterLength(markdown) > LONG_ANSWER_MAX_CHARACTERS ||
    lines.length > LONG_ANSWER_MAX_LINES ||
    paragraphs.length > LONG_ANSWER_MAX_PARAGRAPHS ||
    listItems > LONG_ANSWER_MAX_LIST_ITEMS ||
    structuredBlock;
}

function neutralizeMalformedDetails(markdown: string): string {
  return markdown.replace(
    /```[\s\S]*?(?:```|$)|`[^`\n]*`|<\/?(?:details|summary)(?:\s[^>]*)?>/giu,
    (value) => value.startsWith("`")
      ? value
      : value.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
}

function isShortPlainBlock(block: string | undefined): block is string {
  return block !== undefined && characterLength(block) <= LONG_ANSWER_LEAD_MAX_CHARACTERS &&
    !usesSupportedRichBlockFormatting(block);
}

function collapseLongAnswer(markdown: string, keepClosing: boolean): string {
  if (!isLongAnswer(markdown) || hasTelegramRichDetailsBlock(markdown)) return markdown;
  // Invalid details-like HTML is made inert before the valid backend wrapper is introduced.
  const safeMarkdown = /<\/?details(?:\s[^>]*)?>/iu.test(markdown)
    ? neutralizeMalformedDetails(markdown)
    : markdown;
  const blocks = safeMarkdown.split(/\n\s*\n/gu).filter((part) => part.trim().length > 0);
  const first = blocks[0]?.trim();
  const keepLead = blocks.length > 1 && isShortPlainBlock(first);
  const rest = keepLead ? blocks.slice(1) : blocks;
  // The question reply buttons answer stays visible next to them.
  const last = rest.at(-1)?.trim();
  const closing = keepClosing && rest.length > 1 && isShortPlainBlock(last) ? last : undefined;
  const opened = (closing === undefined ? rest : rest.slice(0, -1)).join("\n\n");
  // A truncated answer may end inside a code block; closed first, it cannot swallow the wrapper.
  const fence = openTrailingFence(opened, readMarkdownTree(opened));
  const body = fence === null ? opened : `${opened.replace(/\s+$/u, "")}\n${fence}`;
  const details = `<details><summary>${LONG_ANSWER_SUMMARY}</summary>\n\n${body}\n\n</details>`;
  return [keepLead ? first : undefined, details, closing].filter((part) => part !== undefined).join("\n\n");
}

function formatPart(
  markdown: string,
  pacing: TelegramChunkPacing,
  carriesButtons: boolean,
): TelegramFinalPresentationChunk[] {
  // Only the opening chunk carries the pause: a provider-sized overflow is the same utterance.
  const chunkPacing = (index: number): TelegramChunkPacing => index === 0 ? pacing : "immediate";
  // Plain text uses Telegram's ordinary 4096-character transport and never receives parse mode.
  const writtenText = (text: string): TelegramFinalPresentationChunk[] => carriesButtons
    ? splitTelegramMessageText(text)
      .map((part, index) => ({ format: "rich", pacing: chunkPacing(index), text: literalRichParagraphs(part) }))
    : splitTelegramMessageText(text)
      .map((part, index) => ({ format: "plain", pacing: chunkPacing(index), text: part }));
  const collapsed = collapseLongAnswer(markdown, carriesButtons);

  if (!usesSupportedRichFormatting(collapsed)) return writtenText(collapsed);
  try {
    return formatTelegramRichMessages(collapsed)
      .map((text, index) => ({ format: "rich", pacing: chunkPacing(index), text }));
  } catch (error) {
    if (!(error instanceof AppError) || !RICH_LIMIT_ERROR_CODES.has(error.code)) throw error;
    console.error(JSON.stringify({ code: "AGENT_TELEGRAM_RICH_FORMAT_DEGRADED", reason: error.code }));
    // The text as written, without the accordion the backend added around it.
    return writtenText(markdown);
  }
}

export function formatTelegramFinalPresentation(
  markdown: string,
  options: TelegramFinalPresentationOptions = {},
): TelegramFinalPresentationChunk[] {
  const normalized = markdown.trim();
  if (!normalized) return [];
  const { asides, main } = splitTelegramAuthoredParts(normalized);
  if (!main) return [];
  const buttons = options.replyButtons === true;

  // The length policy applies to each authored message on its own, so a long main answer still
  // collapses without swallowing the asides its author separated from it.
  return [
    ...formatPart(main, "immediate", buttons && asides.length === 0),
    ...asides.flatMap((aside, index) => formatPart(aside, "aside", buttons && index === asides.length - 1)),
  ];
}
