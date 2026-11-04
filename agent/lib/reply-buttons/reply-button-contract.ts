/**
 * The shape of reply buttons: what is stored, what a press carries back, and the rules every
 * button follows wherever it was written.
 *
 * Exports:
 * - `ReplyButton`, `ReplyButtonRows`, `ReplyButtonColor`: one stored set, row by row. A button is an
 *   answer, a link (`url`) or a copy button (`copyText`).
 * - `isAnswerButton`, `hasAnswerButtons`, `withoutAnswerButtons`: answers need an addressee and a
 *   stored set; links and copy buttons are Telegram's own and stay after a choice.
 * - `validateReplyButtonUrl`, `validateReplyButtonCopyText`: the rules of a link and a copy text.
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
 * - A link opens only a web page, never Telegram itself: a button hides its address, and a `t.me`
 *   address could start a bot or join a chat behind a harmless label a page talked the model into.
 *   A copy text must stand in the message itself, so the person sees what goes to the clipboard.
 */
import { randomBytes } from "node:crypto";

import { AppError } from "../app-error.js";
import { isTelegramWebAddress } from "../telegram-rich-links.js";

export const REPLY_BUTTONS_MAX = 6;
export const REPLY_BUTTONS_ROW_MAX = 3;
export const REPLY_BUTTON_TEXT_MAX_LENGTH = 40;
// Telegram took 256 characters and refused 257 (BUTTON_COPY_TEXT_INVALID), counting characters,
// not bytes: 256 Cyrillic letters and 256 emoji went through (probe of 04.11.2026).
export const REPLY_BUTTON_COPY_TEXT_MAX_LENGTH = 256;
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
  /** A copy button: what goes to the clipboard. */
  readonly copyText?: string;
  readonly text: string;
  /** A link button: the web page it opens. */
  readonly url?: string;
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

const BUTTON_URL_PROTOCOLS = new Set(["http:", "https:"]);

export function isAnswerButton(button: ReplyButton): boolean {
  return button.url === undefined && button.copyText === undefined;
}

export function hasAnswerButtons(rows: ReplyButtonRows): boolean {
  return rows.some((row) => row.some(isAnswerButton));
}

/** The link and copy buttons of a set, row by row; rows left empty go. */
export function withoutAnswerButtons(rows: ReplyButtonRows): ReplyButtonRows {
  return rows.map((row) => row.filter((button) => !isAnswerButton(button))).filter((row) => row.length > 0);
}

/** A web address for a link button; returns it trimmed. */
export function validateReplyButtonUrl(url: string): string {
  const address = url.trim();
  if (!URL.canParse(address) || !BUTTON_URL_PROTOCOLS.has(new URL(address).protocol)) {
    throw new AppError(INVALID_CODE, `Кнопка-ссылка ведёт только на адрес http или https: «${address}»`);
  }
  if (isTelegramWebAddress(address)) {
    throw new AppError(INVALID_CODE, `Кнопка-ссылка не ведёт в Telegram (t.me и похожие адреса): такую ссылку пиши текстом с адресом на виду: «${address}»`);
  }
  return address;
}

/** The text of a copy button, which the shown text of its message must contain as written. */
export function validateReplyButtonCopyText(copyText: string, shownText: string): string {
  if (copyText.trim().length === 0 || Array.from(copyText).length > REPLY_BUTTON_COPY_TEXT_MAX_LENGTH) {
    throw new AppError(INVALID_CODE, `Текст кнопки «Скопировать» — от 1 до ${REPLY_BUTTON_COPY_TEXT_MAX_LENGTH} символов`);
  }
  if (!shownText.includes(copyText)) {
    throw new AppError(INVALID_CODE, `Текст для копирования должен стоять в тексте сообщения так же, как в кнопке: «${copyText}»`);
  }
  return copyText;
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
