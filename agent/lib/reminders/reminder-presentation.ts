/**
 * The one Telegram message a reminder goes out as, laid out the way the chat lays out an answer.
 *
 * Exports:
 * - `REMINDER_HEADER`: the line every reminder opens with.
 * - `reminderBody`: the text under the header, the late-delivery notice included.
 * - `ReminderMessage`, `presentReminder`: the message, ordinary or rich, with the files it shows.
 * - `refusedReminder`: the ordinary message that goes once more when Telegram refused the rich one.
 *
 * Key constructs:
 * - Text without markup, files or buttons goes as an ordinary message with the header bold through
 *   an entity, so what was written is sent exactly as stored and needs no escaping.
 * - Markup or files make a rich message laid out like an answer but never collapsed: a reminder's
 *   words are the point. Buttons alone keep the text literal inside the rich message they need.
 * - A reminder is one message: the directive that splits an answer into messages is removed, and a
 *   text within the reminder's length always fits one.
 */
import {
  presentTelegramAnswer,
  withoutAnswerFiles,
  type PreparedTelegramAnswer,
} from "../answer-files/answer-file-delivery.js";
import { AppError } from "../app-error.js";
import { stripTelegramAsideDirectives } from "../telegram-authored-split.js";
import type { TelegramRichMediaUpload } from "../telegram-rich-messages.js";

export const REMINDER_HEADER = "⏰ Напоминание:";
const RICH_REMINDER_HEADER = `**${REMINDER_HEADER}**`;

export type ReminderMessage =
  | { readonly format: "plain"; readonly text: string }
  | { readonly format: "rich"; readonly markdown: string; readonly media: readonly TelegramRichMediaUpload[] };

export function reminderBody(content: string, delayedNotice: string | null): string {
  return [stripTelegramAsideDirectives(content), delayedNotice].filter((part) => part !== null).join("\n\n");
}

export function presentReminder(prepared: PreparedTelegramAnswer, options: { readonly replyButtons: boolean }): ReminderMessage {
  const chunks = presentTelegramAnswer(prepared, { keepExpanded: true, replyButtons: options.replyButtons });
  if (chunks.length !== 1) {
    throw new AppError("AGENT_REMINDER_PRESENTATION_INVALID", "Напоминание не уложилось в одно сообщение");
  }
  const chunk = chunks[0]!;
  return chunk.format === "plain"
    ? { format: "plain", text: `${REMINDER_HEADER}\n\n${chunk.text}` }
    : { format: "rich", markdown: `${RICH_REMINDER_HEADER}\n\n${chunk.text}`, media: chunk.media };
}

/** Refused for good means not delivered: the words go once more as written, each file a line. */
export function refusedReminder(prepared: PreparedTelegramAnswer): ReminderMessage {
  return { format: "plain", text: `${REMINDER_HEADER}\n\n${withoutAnswerFiles(prepared, "refused").trim()}` };
}
