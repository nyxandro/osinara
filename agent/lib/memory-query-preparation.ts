/**
 * Turning a live message into the text the memory search is actually run on.
 *
 * Export:
 * - `prepareMemoryQuery`: removes the address to the assistant, emoji, and Markdown emphasis.
 *
 * Why this exists: the whole message used to go into the search as typed. The word branches build
 * their condition out of every token in it, so «Осинара, напомни где бэкап» demanded that a record
 * contain the assistant's own name — which most records do not, and the ones that do are unrelated.
 * The same noise pulls the semantic vector sideways. The cleaned text therefore goes to both.
 *
 * What it deliberately does not do: fold «ё» to «е». The morphological branch already folds it in
 * its stemmer and the semantic model does not care; only the exact branch needs it, and it applies
 * the same folding to the query and to its indexed column so the two always agree.
 */
import { AGENT_NAME_STEM_SOURCE } from "./agent-name.js";

/**
 * The assistant's name in the nominative — the form used to call someone — optionally as a
 * Telegram mention. An oblique form («Осинары», «Осинаре») is never an address: it belongs to a
 * question *about* the assistant, and losing the name there is exactly how one project's
 * repository becomes another's.
 */
const ADDRESS_NAME = `(?:@(?:${AGENT_NAME_STEM_SOURCE})[\\p{L}\\p{N}_]*|(?:${AGENT_NAME_STEM_SOURCE})[аa]?)`;

/**
 * A leading address is followed by a comma — right away («Осинара, напомни») or after a greeting
 * («Осинара привет, какой тариф»). Without that comma the name may be the subject of the sentence
 * («Осинара умеет читать PDF?»), and the safe move is to keep it: keeping a word never loses
 * information, removing one can.
 */
const LEADING_ADDRESS_PATTERN = new RegExp(
  `^\\s*${ADDRESS_NAME}\\s*[,!:]\\s*`,
  "iu",
);
/** «Осинара привет, какой тариф» — the greeting sits between the name and the comma. */
const LEADING_ADDRESS_BEFORE_GREETING_PATTERN = new RegExp(
  `^\\s*${ADDRESS_NAME}(?=\\s)\\s*(?=[^,]{0,24},)`,
  "iu",
);
/** A Telegram mention of the assistant opening the message needs no comma to be an address. */
const LEADING_MENTION_PATTERN = new RegExp(
  `^\\s*@(?:${AGENT_NAME_STEM_SOURCE})[\\p{L}\\p{N}_]*\\s*[,!:]?\\s*`,
  "iu",
);
/** The name standing alone between commas is a vocative wherever it sits. */
const ENCLOSED_ADDRESS_PATTERN = new RegExp(`,\\s*${ADDRESS_NAME}\\s*,`, "giu");

// Pictographs, their skin-tone and style modifiers, the zero-width joiner that glues sequences
// together, and the variation selector that turns a plain character into an emoji.
const EMOJI_PATTERN =
  /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{1F3FB}-\u{1F3FF}\u{200D}\u{FE0F}\u{20E3}]/gu;

// Only paired emphasis and code fences, never a bare `*` or `_`: `memory_items` and `*` inside a
// path are far more common here than italics, and stripping them would break the exact branch.
const MARKDOWN_EMPHASIS_PATTERN = /\*\*|__|~~|`/gu;
const MARKDOWN_LINE_PREFIX_PATTERN = /^[ \t]*(?:#{1,6}|>)[ \t]+/gmu;

export function prepareMemoryQuery(query: string): string {
  const prepared = query
    .replace(ENCLOSED_ADDRESS_PATTERN, ", ")
    .replace(LEADING_MENTION_PATTERN, "")
    .replace(LEADING_ADDRESS_PATTERN, "")
    .replace(LEADING_ADDRESS_BEFORE_GREETING_PATTERN, "")
    .replace(EMOJI_PATTERN, " ")
    .replace(MARKDOWN_LINE_PREFIX_PATTERN, "")
    .replace(MARKDOWN_EMPHASIS_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();

  // A message that was nothing but an address leaves nothing to search for — bare punctuation is
  // as empty as an empty string here. Returning the original keeps the previous behaviour for that
  // turn instead of failing the whole memory block on a question that had no words in it.
  return /[\p{L}\p{N}]/u.test(prepared) ? prepared : query;
}
