/**
 * The shape of reply buttons: what is stored, what a press carries back, and the rules every
 * button follows wherever it was written.
 *
 * Exports:
 * - `ReplyButton`, `ReplyButtonRows`, `ReplyButtonColor`: one stored set, row by row.
 * - `REPLY_BUTTON_STYLES`: the Telegram style name of each color.
 * - `validateReplyButtonLabel`: the rules of one label.
 * - `replyButtonLabels`: the labels in press order; a press carries the index into this list.
 * - `REPLY_BUTTON_CALLBACK_PREFIX`, `parseReplyButtonCallback`: the callback data of a button.
 * - `newReplyButtonToken`: the unguessable id of one set inside the callback data.
 * - `selectedReplyCaption`, `DISMISSED_REPLY_CAPTION`: the line a settled message gets.
 * - `REPLY_BUTTON_MESSAGE_ATTRIBUTE`: the turn attribute naming the message a press was made under.
 *
 * Key constructs:
 * - Callback data is client-controlled, so it holds only the set's token and a button index; the
 *   labels and the addressee are read from the database on every press.
 * - A label never contains a character the Telegram rich markdown would read as markup, so the
 *   settled caption can quote it inside the original rich message without escaping.
 */
import { randomBytes } from "node:crypto";

import { AppError } from "../app-error.js";

export const REPLY_BUTTONS_MAX = 6;
export const REPLY_BUTTONS_ROW_MAX = 3;
export const REPLY_BUTTON_TEXT_MAX_LENGTH = 40;
export const REPLY_BUTTON_CALLBACK_PREFIX = "rb:";
export const DISMISSED_REPLY_CAPTION = "Ничего не выбрано";
/** Turn auth attribute of a press: the message whose button was tapped, for replies and reactions. */
export const REPLY_BUTTON_MESSAGE_ATTRIBUTE = "telegramReplyButtonMessageId";

const INVALID_CODE = "AGENT_REPLY_BUTTONS_INVALID";
// Telegram rich markdown reads these as formatting, links, math or HTML.
const MARKUP_CHARACTERS = /[*_~=|`[\]<>\\$#]/u;
// Telegram allows only plain text in a button label, and it turns links, mentions, e-mails, phone
// numbers and commands into entities; such a label could make it refuse the whole message. A site
// counts by a common top-level domain, so "Node.js", a date or an amount stays a plain label.
const AUTO_ENTITY_PATTERN = new RegExp([
  "https?:\\/\\/", "www\\.", "@[\\p{L}\\p{N}_]", "^\\/[\\p{L}\\p{N}_]", "\\+\\d[\\d\\s()-]{6,}\\d",
  "[\\p{L}\\p{N}-]\\.(?:ru|рф|su|com|net|org|info|biz|io|me|co|app|dev|ai|tv|by|kz|ua|uz|de|uk|online|site|shop|store|pro|xyz|tech)(?![\\p{L}\\p{N}])",
].join("|"), "iu");
const TOKEN_BYTES = 16;
const CALLBACK_PATTERN = /^rb:([A-Za-z0-9_-]{22}):([0-9])$/u;

// Telegram's own style names: green, red and blue buttons.
export const REPLY_BUTTON_STYLES = { blue: "primary", green: "success", red: "danger" } as const;
export type ReplyButtonColor = keyof typeof REPLY_BUTTON_STYLES;

export interface ReplyButton {
  readonly color?: ReplyButtonColor;
  readonly text: string;
}

export type ReplyButtonRows = readonly (readonly ReplyButton[])[];

/** One line of 1-40 characters without markup; returns it trimmed. */
export function validateReplyButtonLabel(label: string): string {
  const text = label.trim();
  if (text.length === 0 || Array.from(text).length > REPLY_BUTTON_TEXT_MAX_LENGTH || /[\r\n]/u.test(text)) {
    throw new AppError(INVALID_CODE, `Текст кнопки — одна строка от 1 до ${REPLY_BUTTON_TEXT_MAX_LENGTH} символов: «${text}»`);
  }
  if (MARKUP_CHARACTERS.test(text)) {
    throw new AppError(INVALID_CODE, `В тексте кнопки не должно быть символов разметки * _ ~ = | \` [ ] < > \\ $ #: «${text}»`);
  }
  if (AUTO_ENTITY_PATTERN.test(text)) {
    throw new AppError(INVALID_CODE, `В тексте кнопки не должно быть ссылок, @упоминаний, почты, телефонов и команд: «${text}»`);
  }
  return text;
}

export function replyButtonLabels(rows: ReplyButtonRows): string[] {
  return rows.flatMap((row) => row.map((button) => button.text));
}

export function isReplyButtonCallback(data: string | undefined): data is string {
  return data !== undefined && data.startsWith(REPLY_BUTTON_CALLBACK_PREFIX);
}

/** The set and button a press names, or null for data no set of ours could have produced. */
export function parseReplyButtonCallback(data: string): { index: number; token: string } | null {
  const match = CALLBACK_PATTERN.exec(data);
  return match ? { index: Number(match[2]), token: match[1]! } : null;
}

export function newReplyButtonToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** In a private chat the choice speaks for itself; in a group it names who made it. */
export function selectedReplyCaption(label: string, presserName: string | null): string {
  // A Telegram name is free text: markup characters are dropped so it cannot restyle the message.
  const name = presserName?.replace(new RegExp(MARKUP_CHARACTERS.source, "gu"), "").trim();
  return name ? `Выбрано: ${label} (${name})` : `Выбрано: ${label}`;
}
