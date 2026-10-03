/**
 * Authored splitting of one model answer into separate Telegram messages.
 *
 * Exports:
 * - `TELEGRAM_ASIDE_DIRECTIVE`: service line the model writes between spoken parts.
 * - `TelegramAuthoredParts`: main answer plus the authored asides.
 * - `splitTelegramAuthoredParts`: applies the paced-message ceiling and nothing else.
 * - `stripTelegramAsideDirectives`: durable projection text without transport directives.
 *
 * Key construct:
 * - Where an answer breaks and how each part reads is the author's decision. The ceiling below
 *   limits only how many paced messages one answer can open; a part longer than the Telegram
 *   transport limit is still split further by the presentation layer, as any answer always was.
 * - The directive is transport syntax and never reaches a person: a whole-line directive splits,
 *   any other occurrence is removed. The retired tag-shaped spelling counts as well, so an old
 *   habit of the model cannot leak either. Fenced and indented code keeps its literal content.
 */
import { isIndentedCodeLine, nextFenceState, type FenceState } from "./markdown-code-fence.js";

const TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT = 5;

export const TELEGRAM_ASIDE_DIRECTIVE = "[[split]]";

// A separator that is not shaped like a tag cannot invite a closing tag. The earlier tag-shaped
// spelling is still recognized so a model repeating the old habit never leaks it to a person.
const DIRECTIVE_SOURCE = "\\[\\[split\\]\\]|</?telegram-split\\s*/?>";
// Column zero only: an indented directive belongs to a Markdown code block, not to the transport.
const DIRECTIVE_LINE_PATTERN = new RegExp(`^(?:${DIRECTIVE_SOURCE})[ \\t\\r]*$`, "u");
const INLINE_DIRECTIVE_PATTERN = new RegExp(DIRECTIVE_SOURCE, "gu");
const DIRECTIVE_PRESENCE_PATTERN = new RegExp(DIRECTIVE_SOURCE, "u");

export interface TelegramAuthoredParts {
  readonly asides: readonly string[];
  readonly main: string;
}

function withoutInlineDirective(line: string): string {
  if (!DIRECTIVE_PRESENCE_PATTERN.test(line) || isIndentedCodeLine(line)) return line;
  return line.replace(INLINE_DIRECTIVE_PATTERN, "").replace(/[ \t]{2,}/gu, " ").trimEnd();
}

function authoredParts(markdown: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let fence: FenceState | null = null;
  for (const line of markdown.split("\n")) {
    const openFence = fence;
    fence = nextFenceState(line, fence);
    if (openFence || fence) {
      current.push(line);
      continue;
    }
    if (DIRECTIVE_LINE_PATTERN.test(line)) {
      parts.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(withoutInlineDirective(line));
  }
  parts.push(current.join("\n"));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export function splitTelegramAuthoredParts(markdown: string): TelegramAuthoredParts {
  const parts = authoredParts(markdown);
  const main = parts[0];
  if (main === undefined) return { asides: [], main: "" };
  if (parts.length <= TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT) {
    return { asides: parts.slice(1), main };
  }

  // Nothing the author wrote is dropped: everything past the ceiling joins the last message.
  const delivered = [
    ...parts.slice(0, TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT - 1),
    parts.slice(TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT - 1).join("\n\n"),
  ];
  return { asides: delivered.slice(1), main: delivered[0]! };
}

export function stripTelegramAsideDirectives(markdown: string): string {
  return authoredParts(markdown).join("\n\n");
}
