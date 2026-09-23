/**
 * The model's choice to send a group answer as a standalone message instead of a reply.
 *
 * Exports:
 * - `TELEGRAM_STANDALONE_DIRECTIVE`: service marker the model writes into such an answer.
 * - `TelegramStandaloneReading`: answer text without the marker, plus whether it was present.
 * - `readTelegramStandaloneDirective`: reads and removes the marker.
 *
 * Key construct:
 * - A group answer replies to the triggering message by default. Text written for other people,
 *   such as an announcement a member asked for, reads wrong as a reply to that member, so the
 *   model may opt out. The choice changes only the reply link, never the chat or topic.
 * - The marker is transport syntax and never reaches a person: any occurrence outside code counts
 *   and is removed. Fenced and indented code keeps its literal content.
 */
import { isIndentedCodeLine, nextFenceState, type FenceState } from "./markdown-code-fence.js";

export const TELEGRAM_STANDALONE_DIRECTIVE = "[[no-reply]]";

const DIRECTIVE_LINE_PATTERN = /^\[\[no-reply\]\][ \t\r]*$/u;
const INLINE_DIRECTIVE_PATTERN = /\[\[no-reply\]\]/gu;

export interface TelegramStandaloneReading {
  readonly markdown: string;
  readonly standalone: boolean;
}

export function readTelegramStandaloneDirective(markdown: string): TelegramStandaloneReading {
  const lines: string[] = [];
  let standalone = false;
  let fence: FenceState | null = null;
  let afterBlankMarkerLine = false;
  for (const line of markdown.split("\n")) {
    // A marker line between two paragraphs must not leave a wider gap than the author wrote.
    const skipBlank = afterBlankMarkerLine && line.trim().length === 0;
    afterBlankMarkerLine = false;
    if (skipBlank) continue;
    const openFence = fence;
    fence = nextFenceState(line, fence);
    if (openFence || fence || isIndentedCodeLine(line) || !line.includes(TELEGRAM_STANDALONE_DIRECTIVE)) {
      lines.push(line);
      continue;
    }
    standalone = true;
    // A whole-line marker leaves no blank line behind; an inline one leaves the text around it.
    if (DIRECTIVE_LINE_PATTERN.test(line)) {
      afterBlankMarkerLine = (lines.at(-1) ?? "").trim().length === 0;
      continue;
    }
    lines.push(line.replace(INLINE_DIRECTIVE_PATTERN, "").replace(/[ \t]{2,}/gu, " ").trimEnd());
  }
  return { markdown: lines.join("\n").trim(), standalone };
}
