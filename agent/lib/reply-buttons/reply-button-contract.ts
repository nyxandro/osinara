/**
 * The shape of reply buttons: what the model passes, what Telegram receives, and what a press
 * carries back.
 *
 * Exports:
 * - `REPLY_BUTTON_ROWS_SCHEMA`, `parseReplyButtonRows`: the model-facing rows and their validation.
 * - `replyButtonLabels`: the labels in press order; a press carries the index into this list.
 * - `replyButtonKeyboard`: the Telegram inline keyboard of one stored set.
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
import { z } from "zod";

import { AppError } from "../app-error.js";

export const REPLY_BUTTONS_MAX = 6;
export const REPLY_BUTTONS_ROW_MAX = 3;
export const REPLY_BUTTON_TEXT_MAX_LENGTH = 40;
export const REPLY_BUTTON_CALLBACK_PREFIX = "rb:";
export const DISMISSED_REPLY_CAPTION = "Ничего не выбрано";
/** Turn auth attribute of a press: the message whose button was tapped, for replies and reactions. */
export const REPLY_BUTTON_MESSAGE_ATTRIBUTE = "telegramReplyButtonMessageId";

const INPUT_ERROR_CODE = "AGENT_REPLY_BUTTONS_INPUT_INVALID";
// Telegram rich markdown reads these as formatting, links, math or HTML.
const MARKUP_CHARACTERS = /[*_~=|`[\]<>\\$#]/u;
const TOKEN_BYTES = 16;
const CALLBACK_PATTERN = /^rb:([A-Za-z0-9_-]{22}):([0-9])$/u;

// Telegram's own style names: green, red and blue buttons.
const TELEGRAM_STYLES = { blue: "primary", green: "success", red: "danger" } as const;
export type ReplyButtonColor = keyof typeof TELEGRAM_STYLES;

export interface ReplyButton {
  readonly color?: ReplyButtonColor;
  readonly text: string;
}

export type ReplyButtonRows = readonly (readonly ReplyButton[])[];

const BUTTON_SCHEMA = z.strictObject({
  color: z.enum(["green", "red", "blue"])
    .describe("Optional. green: the main yes; red: cancel or something irreversible; blue: the main alternative. Leave the rest uncolored.")
    .optional(),
  text: z.string()
    .describe(`What the person answers by tapping, 1-${REPLY_BUTTON_TEXT_MAX_LENGTH} characters, may start with an emoji, e.g. "✅ Да, заказываем"`),
});

export const REPLY_BUTTON_ROWS_SCHEMA = z.array(
  z.array(BUTTON_SCHEMA).describe(`One row of 1-${REPLY_BUTTONS_ROW_MAX} buttons shown side by side`),
).describe(`Rows from top to bottom, ${REPLY_BUTTONS_MAX} buttons at most in total`);

function inputError(message: string): never {
  throw new AppError(INPUT_ERROR_CODE, message);
}

/** Validates rows the model passed; every rule is stated in the error the model reads. */
export function parseReplyButtonRows(raw: unknown): ReplyButtonRows {
  const parsed = REPLY_BUTTON_ROWS_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    inputError("Кнопки передаются как rows: массив рядов, в ряду объекты {\"text\":\"✅ Да\",\"color\":\"green\"}; color необязателен: green, red или blue");
  }
  const rows = parsed.data;
  const total = rows.reduce((sum, row) => sum + row.length, 0);
  if (rows.length === 0 || total === 0 || total > REPLY_BUTTONS_MAX) {
    inputError(`Нужно от 1 до ${REPLY_BUTTONS_MAX} кнопок`);
  }
  if (rows.some((row) => row.length === 0 || row.length > REPLY_BUTTONS_ROW_MAX)) {
    inputError(`В каждом ряду от 1 до ${REPLY_BUTTONS_ROW_MAX} кнопок`);
  }
  const seen = new Set<string>();
  const normalized = rows.map((row) => row.map((button) => {
    const text = button.text.trim();
    if (text.length === 0 || Array.from(text).length > REPLY_BUTTON_TEXT_MAX_LENGTH || /[\r\n]/u.test(text)) {
      inputError(`Текст кнопки — одна строка от 1 до ${REPLY_BUTTON_TEXT_MAX_LENGTH} символов: «${text}»`);
    }
    if (MARKUP_CHARACTERS.test(text)) {
      inputError(`В тексте кнопки не должно быть символов разметки * _ ~ = | \` [ ] < > \\ $ #: «${text}»`);
    }
    const key = text.toLowerCase();
    if (seen.has(key)) inputError(`Тексты кнопок не должны повторяться: «${text}»`);
    seen.add(key);
    return button.color === undefined ? { text } : { color: button.color, text };
  }));
  return normalized;
}

export function replyButtonLabels(rows: ReplyButtonRows): string[] {
  return rows.flatMap((row) => row.map((button) => button.text));
}

export function replyButtonKeyboard(token: string, rows: ReplyButtonRows): { inline_keyboard: { [key: string]: string }[][] } {
  let index = 0;
  return {
    inline_keyboard: rows.map((row) => row.map((button) => ({
      callback_data: `${REPLY_BUTTON_CALLBACK_PREFIX}${token}:${index++}`,
      ...(button.color === undefined ? {} : { style: TELEGRAM_STYLES[button.color] }),
      text: button.text,
    }))),
  };
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
