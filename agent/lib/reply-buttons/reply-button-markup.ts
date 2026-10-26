/**
 * Reply buttons as the model writes them: Telegram's own rich-message button markup in the text.
 *
 * Exports:
 * - `ReplyButtonMarkupReading`: the text without any button markup, plus its buttons or the reason
 *   they were refused.
 * - `readReplyButtonMarkup`: reads and removes the markup of one text.
 * - `replyButtonMarkup`: writes stored rows back as markup, for the model or, with a set's token,
 *   for Telegram.
 *
 * Key constructs:
 * - The model writes only what a person sees: the label and an optional color. What a press
 *   carries is the backend's: its own token and the button's index, never the model's `data`.
 * - Only answer buttons exist here. A link, a mini app or a copy button would let text the model
 *   read on a page reach a person as an action, so any other type refuses the whole set.
 * - The set is all or nothing: a half-kept set could drop the "no" and leave only the "yes".
 * - Every tag is removed from the text whether the buttons were accepted or not, so markup never
 *   reaches a person as text; the words between the tags stay. Code keeps its literal content, and
 *   code here is only what Telegram itself shows as code: a fenced block or an inline code span. An
 *   indented line continues the paragraph or list item above it, and an escaped backtick opens
 *   nothing, so a tag there would be live and is read like any other.
 * - The usual slips of a model are read as meant: the `data` it copied from the documentation, a
 *   row left open at the very end, buttons without a row, rows on several lines, a row wider than
 *   fits. Presentation only falls back: an unknown style leaves the button uncolored.
 */
import { AppError } from "../app-error.js";
import { nextFenceState, type FenceState } from "../markdown-code-fence.js";
import {
  REPLY_BUTTON_CALLBACK_PREFIX,
  REPLY_BUTTON_STYLES,
  REPLY_BUTTONS_MAX,
  REPLY_BUTTONS_ROW_MAX,
  validateReplyButtonLabel,
  type ReplyButton,
  type ReplyButtonColor,
  type ReplyButtonRows,
} from "./reply-button-contract.js";

export interface ReplyButtonMarkupReading {
  /** Why markup present in the text gave no buttons; null when it gave them or there was none. */
  readonly error: AppError | null;
  readonly markdown: string;
  readonly rows: ReplyButtonRows | null;
}

const INVALID_CODE = "AGENT_REPLY_BUTTONS_INVALID";
// Code is replaced by this character before the scan, so no tag can start or end inside it.
const CODE_MASK = "\u0000";
const NOT_CODE = "[^\\u0000]";
// Telegram's documented answer type, and the short spelling a model writes for it.
const ANSWER_TYPES = new Set(["callback", "callback_data"]);
const COLOR_BY_STYLE: Readonly<Record<string, ReplyButtonColor>> = {
  blue: "blue",
  danger: "red",
  green: "green",
  primary: "blue",
  red: "red",
  success: "green",
};
const TOKEN_PATTERN = new RegExp([
  `<tg-button-row(?![\\w-])(?<rowAttributes>[^>\\u0000\\n]*)>`,
  `<\\/tg-button-row\\s*>`,
  // A label never runs into the next tag, so one unclosed button cannot swallow the rest.
  `<tg-button(?![\\w-])(?<attributes>[^>\\u0000\\n]*)>(?<label>(?:(?!<\\/?tg-button)${NOT_CODE})*?)<\\/tg-button\\s*>`,
  `<\\/?tg-button(?:-row)?(?![\\w-])[^>\\u0000\\n]*>?`,
].join("|"), "giu");
const ATTRIBUTE_PATTERN = /([A-Za-z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gu;
// A backslash before the opening backtick escapes it, so no code span starts there.
const INLINE_CODE_PATTERN = /(?<![\\`])(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/gu;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"",
};

interface RawButton {
  readonly attributes: string;
  readonly label: string;
}

function invalid(message: string): never {
  throw new AppError(INVALID_CODE, message);
}

/** The text with fenced and inline code replaced by the mask, index for index. */
function maskCode(markdown: string): string {
  let fence: FenceState | null = null;
  return markdown.split("\n").map((line) => {
    const openFence = fence;
    fence = nextFenceState(line, fence);
    if (openFence || fence) return CODE_MASK.repeat(line.length);
    return line.replace(INLINE_CODE_PATTERN, (code) => CODE_MASK.repeat(code.length));
  }).join("\n");
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]+));/giu, (entity, decimal, hex, name) => {
    if (decimal !== undefined || hex !== undefined) {
      const codePoint = decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16);
      return codePoint > 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : entity;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    attributes.set(match[1]!.toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

function toButton(raw: RawButton): ReplyButton {
  const attributes = attributesOf(raw.attributes);
  const type = attributes.get("type");
  if (type !== undefined && !ANSWER_TYPES.has(type.toLowerCase())) {
    invalid(`Кнопка может быть только ответом, type="${type}" не поддерживается`);
  }
  const text = validateReplyButtonLabel(decodeEntities(raw.label).replace(/\s+/gu, " "));
  const style = attributes.get("style") ?? attributes.get("color");
  const color = style === undefined ? undefined : COLOR_BY_STYLE[style.toLowerCase()];
  return color === undefined ? { text } : { color, text };
}

function toRows(rawRows: readonly (readonly RawButton[])[]): ReplyButtonRows {
  const rows = rawRows.map((row) => row.map(toButton)).filter((row) => row.length > 0);
  const total = rows.reduce((sum, row) => sum + row.length, 0);
  if (total === 0 || total > REPLY_BUTTONS_MAX) invalid(`Нужно от 1 до ${REPLY_BUTTONS_MAX} кнопок`);
  const seen = new Set<string>();
  for (const button of rows.flat()) {
    const key = button.text.toLowerCase();
    if (seen.has(key)) invalid(`Тексты кнопок не должны повторяться: «${button.text}»`);
    seen.add(key);
  }
  return rows.flatMap((row) => {
    const parts: ReplyButton[][] = [];
    for (let start = 0; start < row.length; start += REPLY_BUTTONS_ROW_MAX) {
      parts.push(row.slice(start, start + REPLY_BUTTONS_ROW_MAX));
    }
    return parts;
  });
}

/** A private-use character the text does not contain, to mark where a tag stood. */
function spanMarker(markdown: string): string {
  for (let codePoint = 0xE000; codePoint <= 0xF8FF; codePoint += 1) {
    const marker = String.fromCodePoint(codePoint);
    if (!markdown.includes(marker)) return marker;
  }
  throw new AppError("AGENT_REPLY_BUTTONS_MARKER_UNAVAILABLE", "Не удалось безопасно убрать разметку кнопок из ответа");
}

/**
 * Removes the tag spans; a line left with nothing but tags goes too, without widening a gap. A tag
 * inside a line leaves a space, so the text on its two sides can never join into a new tag.
 */
function withoutSpans(markdown: string, spans: readonly (readonly [number, number])[]): string {
  const marker = spanMarker(markdown);
  let marked = "";
  let position = 0;
  for (const [start, end] of spans) {
    marked += markdown.slice(position, start) + marker;
    position = end;
  }
  marked += markdown.slice(position);
  const lines: string[] = [];
  let removedAfterBlank = false;
  for (const line of marked.split("\n")) {
    if (!line.includes(marker)) {
      // A removed line between two blank ones would otherwise leave a double gap.
      if (removedAfterBlank && line.trim().length === 0) {
        removedAfterBlank = false;
        continue;
      }
      removedAfterBlank = false;
      lines.push(line);
      continue;
    }
    // Only the spacing around a removed tag closes up; the rest of the line stays as written.
    const spaced = line.replace(new RegExp(`(?:[ \\t]*${marker})+[ \\t]*`, "gu"), " ").trimEnd();
    // A line that began with a tag does not gain an indent from it.
    const rest = line.startsWith(marker) ? spaced.trimStart() : spaced;
    if (rest.trim().length > 0) {
      lines.push(rest);
      removedAfterBlank = false;
      continue;
    }
    removedAfterBlank = removedAfterBlank || (lines.at(-1) ?? "").trim().length === 0;
  }
  return lines.join("\n").trim();
}

export function readReplyButtonMarkup(markdown: string): ReplyButtonMarkupReading {
  const scan = maskCode(markdown);
  const spans: [number, number][] = [];
  const rows: RawButton[][] = [];
  let row: RawButton[] | null = null;
  let looseRow: RawButton[] | null = null;
  let problem: string | null = null;
  let last = 0;
  for (const match of scan.matchAll(TOKEN_PATTERN)) {
    const start = match.index;
    const between = scan.slice(last, start);
    const token = match[0];
    last = start + token.length;
    spans.push([start, last]);
    if (between.trim().length > 0) {
      if (row !== null) problem ??= "Внутри ряда кнопок посторонний текст: текст пишется до ряда";
      looseRow = null;
    }
    if (match.groups?.rowAttributes !== undefined) {
      row = [];
      rows.push(row);
      looseRow = null;
    } else if (/^<\/tg-button-row/iu.test(token)) {
      if (row === null) problem ??= "Разметка кнопок не закрыта или закрыта лишний раз";
      row = null;
    } else if (match.groups?.label !== undefined) {
      const button = { attributes: match.groups.attributes ?? "", label: match.groups.label };
      if (row !== null) {
        row.push(button);
      } else {
        if (looseRow === null) {
          looseRow = [];
          rows.push(looseRow);
        }
        looseRow.push(button);
      }
    } else {
      problem ??= "Разметка кнопок не закрыта или закрыта лишний раз";
    }
  }
  if (spans.length === 0) return { error: null, markdown, rows: null };
  if (row !== null && scan.slice(last).trim().length > 0) {
    problem ??= "Внутри ряда кнопок посторонний текст: текст пишется до ряда";
  }
  const text = withoutSpans(markdown, spans);
  try {
    if (problem !== null) invalid(problem);
    return { error: null, markdown: text, rows: toRows(rows) };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { error, markdown: text, rows: null };
  }
}

function escapeLabel(text: string): string {
  // A label has no angle brackets; an ampersand would otherwise start an entity.
  return text.replaceAll("&", "&amp;");
}

/** Without a token: what the model reads and writes. With one: what Telegram receives. */
export function replyButtonMarkup(rows: ReplyButtonRows, token?: string): string {
  let index = 0;
  return rows.map((row) => {
    const buttons = row.map((button) => {
      const press = token === undefined ? "" : ` type="callback_data" data="${REPLY_BUTTON_CALLBACK_PREFIX}${token}:${index}"`;
      index += 1;
      const style = button.color === undefined ? "" : ` style="${REPLY_BUTTON_STYLES[button.color]}"`;
      return `<tg-button${press}${style}>${escapeLabel(button.text)}</tg-button>`;
    }).join("");
    return `<tg-button-row>${buttons}</tg-button-row>`;
  }).join("\n");
}
