/**
 * What a person sees of an answer while the model is still writing it.
 *
 * Export:
 * - `previewAnswerText`: the rich markdown of the draft for the text so far, or null while there is
 *   nothing a person should see yet.
 *
 * Key constructs:
 * - The preview goes through the same reading as the delivered answer (`telegram-progress.ts`): the
 *   reply choice, the memory line and the split into messages are read by the same functions, and
 *   the text by the same filter (`formatTelegramRichMessages`), so no link opens in it that would
 *   not open in the answer.
 * - What only the backend reads never shows, even half-written: a reaction or a silence shows
 *   nothing, the buttons and an unfinished tag, link, file or line at the end are cut until written.
 * - A draft cannot carry a new file, so a file shows as a line with its caption.
 * - Reasoning is cut too, finished or not. The current hub sends it apart from the text (checked on
 *   04.11.2026), but in July 2026 a model wrote it into the text and the stream showed it.
 */
import { posix } from "node:path";

import { EMPTY_DELIVERY_MARKER } from "../../runtime/turn/step-history.js";
import { readMemoryUsageDirective } from "../memory-usage-directive.js";
import { splitTelegramAuthoredParts } from "../telegram-authored-split.js";
import { formatTelegramRichMessages } from "../telegram-rich-markdown.js";
import { readTelegramStandaloneDirective, TELEGRAM_STANDALONE_DIRECTIVE } from "../telegram-standalone-directive.js";

const REACTION_TAG = "<telegram-reaction";
const REASONING_BLOCK_PATTERN = /<think>[\s\S]*?<\/think>/giu;
const OPEN_REASONING_PATTERN = /<think>[\s\S]*$/iu;
const STRAY_REASONING_CLOSE_PATTERN = /<\/think>/giu;
const SPLIT_DIRECTIVE_PATTERN = /\[\[split\]\]|<\/?telegram-split\s*\/?>/giu;
const BUTTONS_START_PATTERN = /<tg-button(?:-row)?(?![\w-])/iu;
const WORKSPACE_FILE_PATTERN = /!\[([^\]\n]*)\]\(\s*<?(\/workspace\/[^)>\n]*?)>?(?:\s+"[^"\n]*")?\s*\)/gu;
// A draft shows no file and no map; the gallery's files already became lines.
const GALLERY_AND_MAP_PATTERN = /<\/?tg-(?:collage|slideshow)\s*>|<tg-map(?![\w-])[^>\n]*>/giu;
const UNFINISHED_ENDINGS: readonly RegExp[] = [
  // A moment whose closing tag is not written yet.
  /<tg-time(?![\w-])[^>\n]*>(?![\s\S]*<\/tg-time>)[\s\S]*$/iu,
  // An image or a link not closed yet: `![…`, `[…`, `[…](…`.
  /!?\[[^\]\n]*(?:\]\([^)\n]*)?$/u,
  // A service line not closed yet: `[[spl`, `[[no-re`.
  /\[\[[^\]\n]*$/u,
  // A tag not closed yet.
  /<[^>\n]*$/u,
];

function fileLine(caption: string, path: string): string {
  return `📎 ${caption.trim() || posix.basename(path)}`;
}

/** The text with everything only the backend reads taken out, or null when nothing may show yet. */
function visibleText(textSoFar: string): string | null {
  const text = textSoFar
    .replace(REASONING_BLOCK_PATTERN, "")
    .replace(OPEN_REASONING_PATTERN, "")
    .replace(STRAY_REASONING_CLOSE_PATTERN, "")
    .trimStart();
  if (text.length === 0) return null;
  // A reaction and a silence are the whole answer; until the first characters settle it, wait.
  for (const directive of [REACTION_TAG, EMPTY_DELIVERY_MARKER, TELEGRAM_STANDALONE_DIRECTIVE]) {
    if (directive.startsWith(text)) return null;
  }
  if (text.includes(REACTION_TAG) || text.includes(EMPTY_DELIVERY_MARKER)) return null;
  const answer = readMemoryUsageDirective(readTelegramStandaloneDirective(text).markdown).answer;
  const parts = splitTelegramAuthoredParts(answer);
  let shown = (parts.asides.at(-1) ?? parts.main).replace(SPLIT_DIRECTIVE_PATTERN, "");
  const buttons = BUTTONS_START_PATTERN.exec(shown);
  if (buttons) shown = shown.slice(0, buttons.index);
  shown = shown.replace(WORKSPACE_FILE_PATTERN, (_whole, caption: string, path: string) => fileLine(caption, path))
    .replace(GALLERY_AND_MAP_PATTERN, "");
  for (const ending of UNFINISHED_ENDINGS) shown = shown.replace(ending, "");
  shown = shown.trim();
  return shown.length === 0 ? null : shown;
}

export function previewAnswerText(textSoFar: string): string | null {
  const text = visibleText(textSoFar);
  if (text === null) return null;
  try {
    // An answer too long for one message shows its last part, the one being written.
    return formatTelegramRichMessages(text).at(-1) ?? null;
  } catch {
    // A half-written table or block the filter refuses: the preview waits for more text.
    return null;
  }
}
