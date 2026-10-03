/**
 * Deterministic Telegram final-presentation selection.
 *
 * Exports:
 * - `TelegramChunkPacing`: whether a chunk opens an authored aside or continues immediately.
 * - `TelegramFinalPresentationChunk`: one plain or rich provider-sized delivery unit.
 * - `formatTelegramFinalPresentation`: selects plain text unless supported markup is present.
 *
 * Key construct:
 * - Transport selection depends on authored syntax, not message length or a hidden default.
 * - An authored aside is a separate paced message; a length-driven split never is.
 * - Every authored message passes the length policy on its own.
 */
import { splitTelegramMessageText } from "../runtime/telegram/api.js";

import {
  formatTelegramRichMessages,
  hasTelegramRichDetailsBlock,
} from "./telegram-rich-markdown.js";
import { splitTelegramAuthoredParts } from "./telegram-authored-split.js";

export type TelegramChunkPacing = "aside" | "immediate";

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

function collapseLongAnswer(markdown: string): string {
  if (!isLongAnswer(markdown) || hasTelegramRichDetailsBlock(markdown)) return markdown;
  // Invalid details-like HTML is made inert before the valid backend wrapper is introduced.
  const safeMarkdown = /<\/?details(?:\s[^>]*)?>/iu.test(markdown)
    ? neutralizeMalformedDetails(markdown)
    : markdown;
  const blocks = safeMarkdown.split(/\n\s*\n/gu).filter((part) => part.trim().length > 0);
  const first = blocks[0]?.trim();
  const keepLead = first !== undefined && blocks.length > 1 &&
    characterLength(first) <= LONG_ANSWER_LEAD_MAX_CHARACTERS &&
    !usesSupportedRichBlockFormatting(first);
  const body = (keepLead ? blocks.slice(1) : blocks).join("\n\n");
  const details = `<details><summary>${LONG_ANSWER_SUMMARY}</summary>\n\n${body}\n\n</details>`;
  return keepLead ? `${first}\n\n${details}` : details;
}

function formatPart(
  markdown: string,
  pacing: TelegramChunkPacing,
): TelegramFinalPresentationChunk[] {
  // Only the opening chunk carries the pause: a provider-sized overflow is the same utterance.
  const chunkPacing = (index: number): TelegramChunkPacing => index === 0 ? pacing : "immediate";

  // Plain text uses Telegram's ordinary 4096-character transport and never receives parse mode.
  if (!usesSupportedRichFormatting(markdown)) {
    return splitTelegramMessageText(markdown)
      .map((text, index) => ({ format: "plain", pacing: chunkPacing(index), text }));
  }
  return formatTelegramRichMessages(markdown)
    .map((text, index) => ({ format: "rich", pacing: chunkPacing(index), text }));
}

export function formatTelegramFinalPresentation(
  markdown: string,
): TelegramFinalPresentationChunk[] {
  const normalized = markdown.trim();
  if (!normalized) return [];
  const { asides, main } = splitTelegramAuthoredParts(normalized);
  if (!main) return [];

  // The length policy applies to each authored message on its own, so a long main answer still
  // collapses without swallowing the asides its author separated from it.
  return [
    ...formatPart(collapseLongAnswer(main), "immediate"),
    ...asides.flatMap((aside) => formatPart(collapseLongAnswer(aside), "aside")),
  ];
}
