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
 * - The answer goes out as the model laid it out: whether to hide part of a long answer in a
 *   collapsible block is the model's decision, and nothing is collapsed for it.
 * - Reply buttons exist only in a rich message, so an answer carrying them ends in one. Text that
 *   would have gone plain stays literal there, line breaks included.
 * - Model-authored formatting must not cost the answer: a message a rich message cannot hold (an
 *   over-wide table, too deep nesting, one indivisible block over the size limit) goes out as the
 *   text the model wrote, the way plain text does.
 * - Media exist only in a rich message, so a part that carries them is rich even without markup.
 */
import { splitTelegramMessageText } from "../runtime/telegram/api.js";

import { AppError } from "./app-error.js";
import { formatTelegramRichMessages } from "./telegram-rich-markdown.js";
import { splitTelegramAuthoredParts } from "./telegram-authored-split.js";
import { neutralizeTelegramRichLinks } from "./telegram-rich-links.js";
import { literalRichParagraphs } from "./telegram-rich-literal.js";

export type TelegramChunkPacing = "aside" | "immediate";

export interface TelegramFinalPresentationOptions {
  /** Reply buttons go out under the last message of the answer. */
  readonly replyButtons?: boolean;
  /** A part this holds true for goes rich even without markup: only a rich message carries media. */
  readonly requiresRich?: (part: string) => boolean;
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

function formatPart(
  markdown: string,
  pacing: TelegramChunkPacing,
  part: { readonly carriesButtons: boolean; readonly carriesMedia: boolean },
): TelegramFinalPresentationChunk[] {
  const { carriesButtons, carriesMedia } = part;
  // Only the opening chunk carries the pause: a provider-sized overflow is the same utterance.
  const chunkPacing = (index: number): TelegramChunkPacing => index === 0 ? pacing : "immediate";
  // Plain text uses Telegram's ordinary 4096-character transport and never receives parse mode.
  // A literal rich message does go through rich parsing, and whether Telegram reads Markdown inside
  // its paragraphs is not verified, so its links pass the same filter as any rich message.
  const writtenText = (text: string): TelegramFinalPresentationChunk[] => carriesButtons
    ? splitTelegramMessageText(neutralizeTelegramRichLinks(text))
      .map((part, index) => ({ format: "rich", pacing: chunkPacing(index), text: literalRichParagraphs(part) }))
    : splitTelegramMessageText(text)
      .map((part, index) => ({ format: "plain", pacing: chunkPacing(index), text: part }));
  if (!carriesMedia && !usesSupportedRichFormatting(markdown)) return writtenText(markdown);
  try {
    return formatTelegramRichMessages(markdown)
      .map((text, index) => ({ format: "rich", pacing: chunkPacing(index), text }));
  } catch (error) {
    if (!(error instanceof AppError) || !RICH_LIMIT_ERROR_CODES.has(error.code)) throw error;
    console.error(JSON.stringify({ code: "AGENT_TELEGRAM_RICH_FORMAT_DEGRADED", reason: error.code }));
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
  const part = (text: string, carriesButtons: boolean) => ({
    carriesButtons,
    carriesMedia: options.requiresRich?.(text) === true,
  });

  return [
    ...formatPart(main, "immediate", part(main, buttons && asides.length === 0)),
    ...asides.flatMap((aside, index) => formatPart(aside, "aside", part(aside, buttons && index === asides.length - 1))),
  ];
}
