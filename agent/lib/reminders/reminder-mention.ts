/**
 * The mark of a person at the start of a reminder set from their private question (`/me`, #467).
 *
 * Exports:
 * - `ReminderMention`: who is marked.
 * - `richReminderWithMention`, `plainReminderWithMention`: the reminder's Telegram message with the mark
 *   right after its header.
 *
 * Key constructs:
 * - The mark is added by the application after the model's text was made safe: the model's own `tg://` links
 *   stay removed, and the person is notified even without a username.
 * - The name is shown as Telegram had it when the reminder was set; characters that are markup are left out of
 *   the link's caption so a name can never break the message.
 */
import { REMINDER_HEADER } from "./reminder-presentation.js";

export interface ReminderMention {
  readonly name: string;
  readonly telegramUserId: string;
}

const RICH_HEADER = `**${REMINDER_HEADER}**`;
// Shown when a name is made only of markup characters: a caption is required, and this one still reads.
const FALLBACK_CAPTION = "тебе";

function caption(name: string): string {
  const cleaned = name.replace(/[[\]()<>\\*_`~|#]/gu, "").replace(/\s+/gu, " ").trim();
  return cleaned || FALLBACK_CAPTION;
}

/** The rich message's markdown begins with the bold header the presentation wrote. */
export function richReminderWithMention(markdown: string, mention: ReminderMention): string {
  if (!markdown.startsWith(RICH_HEADER)) {
    throw new Error("AGENT_REMINDER_MENTION_LAYOUT_INVALID: a rich reminder must start with its header");
  }
  const body = markdown.slice(RICH_HEADER.length).replace(/^\s+/u, "");
  return `${RICH_HEADER}\n\n[${caption(mention.name)}](tg://user?id=${mention.telegramUserId}), ${body}`;
}

/** The plain message: the name after the header, marked by a `text_mention` entity (offsets in UTF-16 units). */
export function plainReminderWithMention(text: string, mention: ReminderMention): {
  readonly entities: readonly Record<string, unknown>[];
  readonly text: string;
} {
  if (!text.startsWith(REMINDER_HEADER)) {
    throw new Error("AGENT_REMINDER_MENTION_LAYOUT_INVALID: a plain reminder must start with its header");
  }
  const name = caption(mention.name);
  const body = text.slice(REMINDER_HEADER.length).replace(/^\s+/u, "");
  const prefix = `${REMINDER_HEADER}\n\n`;
  return {
    entities: [
      { length: REMINDER_HEADER.length, offset: 0, type: "bold" },
      { length: name.length, offset: prefix.length, type: "text_mention", user: { id: Number(mention.telegramUserId) } },
    ],
    text: `${prefix}${name}, ${body}`,
  };
}
