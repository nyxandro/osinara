/**
 * Telegram's own rich tags a model-authored answer may carry: a moment shown in the reader's time
 * zone, a map, a collage and a slideshow. Every other `tg-` tag stays dead (`telegram-rich-markdown.ts`).
 *
 * Exports:
 * - `canonicalTelegramRichTag`: the one form Telegram receives for an allowed tag, or null.
 * - `isCanonicalTelegramRichMoment`: a moment already in that form, which the filter reads again on
 *   every pass of its own output.
 * - `isSelfClosingTelegramRichTag`: a map stands alone; the others open and close.
 * - `telegramRichTagsNotice`: what the model is to fix in these tags before the answer goes out.
 * - `separateTelegramRichContainers`: the collage and slideshow tags on lines of their own.
 *
 * Key constructs:
 * - Telegram refuses the whole message over one wrong tag (RICH_MESSAGE_GEO_INVALID,
 *   RICH_MESSAGE_DATE_FORMAT_INVALID, tried in a live chat on 04.11.2026), so a tag it would refuse
 *   is no tag here: it becomes text, and the answer check asks the model to fix it first.
 * - The model writes a moment as ISO 8601 with its offset, the way it already passes a reminder's
 *   time; the backend counts Telegram's Unix seconds. A model's own `unix` is refused by the answer
 *   check: a wrong count would show every reader a wrong time. The filter, which reads its own
 *   output again, keeps a moment already in the canonical form.
 * - A tag name stays attached to its bracket, as for the other allowed tags, so ordinary text such
 *   as `< tg-map>` is never revived as markup.
 * - Markdown reads the lines after an HTML tag as raw HTML up to a blank line, and would not see
 *   the files inside a container written without blank lines; Telegram takes both spellings.
 */
import { markdownCodeRanges, readMarkdownTree } from "./markdown-syntax.js";

const TAG_PATTERN = /^<(\/?)(tg-[a-z]+)(?![\w-])([^<>]*?)\s*(\/?)>$/iu;
const ATTRIBUTE_PATTERN = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/gu;
const CONTAINER_NAMES = new Set(["tg-collage", "tg-slideshow"]);
const MAP_NAME = "tg-map";
const TIME_NAME = "tg-time";
const COORDINATE_PATTERN = /^-?\d{1,3}(?:\.\d{1,12})?$/u;
const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;
const ZOOM_PATTERN = /^\d{1,2}$/u;
// Telegram's map zoom levels, `InputRichBlockMap.zoom`.
const MAX_ZOOM = 24;
const MOMENT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/u;
// Telegram's date-time entity format, `r|w?[dD]?[tT]?` (formatting, «Date-time entity formatting»).
const TIME_FORMAT_PATTERN = /^(?:r|w?[dD]?[tT]?)$/u;
const CANONICAL_MOMENT_PATTERN = /^<tg-time unix="\d{1,12}" format="(?:r|w?[dD]?[tT]?)">$/u;
const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_SECOND = 1_000;
const SCANNED_TAG_PATTERN = /<\/?tg-(?:collage|map|slideshow|time)(?![\w-])[^<>\n]*>/giu;
const CONTAINER_TAG_PATTERN = /<\/?tg-(?:collage|slideshow)\s*>/giu;

interface ParsedTag {
  readonly attributes: ReadonlyMap<string, string>;
  readonly closing: boolean;
  readonly name: string;
  readonly selfClosing: boolean;
}

/** The tag's attributes, or null when anything but well-quoted attributes stands between its brackets. */
function parseTag(tag: string): ParsedTag | null {
  const match = TAG_PATTERN.exec(tag);
  if (!match) return null;
  const source = match[3]!;
  const attributes = new Map<string, string>();
  const rest = source.replace(ATTRIBUTE_PATTERN, (_whole, name: string, double?: string, single?: string) => {
    attributes.set(name.toLowerCase(), double ?? single ?? "");
    return " ";
  });
  if (rest.trim().length > 0) return null;
  return { attributes, closing: match[1] === "/", name: match[2]!.toLowerCase(), selfClosing: match[4] === "/" };
}

function hasOnly(attributes: ReadonlyMap<string, string>, allowed: readonly string[]): boolean {
  return [...attributes.keys()].every((name) => allowed.includes(name));
}

function coordinate(value: string | undefined, limit: number): string | null {
  if (value === undefined || !COORDINATE_PATTERN.test(value)) return null;
  return Math.abs(Number(value)) <= limit ? value : null;
}

/** Telegram's Unix time of a moment written with its offset, or null for one it cannot be. */
export function momentUnixTime(moment: string): number | null {
  const match = MOMENT_PATTERN.exec(moment);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls 30 February into March: a moment that does not exist reads back differently.
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day ||
    wall.getUTCHours() !== hour || wall.getUTCMinutes() !== minute || wall.getUTCSeconds() !== second) {
    return null;
  }
  const offset = match[7]!;
  const offsetMinutes = offset === "Z" ? 0 : (offset.startsWith("-") ? -1 : 1) *
    (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  return (wall.getTime() - offsetMinutes * MILLISECONDS_PER_MINUTE) / MILLISECONDS_PER_SECOND;
}

function canonicalMap(attributes: ReadonlyMap<string, string>): string | null {
  if (!hasOnly(attributes, ["lat", "long", "zoom"])) return null;
  const latitude = coordinate(attributes.get("lat"), MAX_LATITUDE);
  const longitude = coordinate(attributes.get("long"), MAX_LONGITUDE);
  if (latitude === null || longitude === null) return null;
  const zoom = attributes.get("zoom");
  if (zoom !== undefined && (!ZOOM_PATTERN.test(zoom) || Number(zoom) > MAX_ZOOM)) return null;
  return `<${MAP_NAME} lat="${latitude}" long="${longitude}"${zoom === undefined ? "" : ` zoom="${Number(zoom)}"`}/>`;
}

function canonicalTime(attributes: ReadonlyMap<string, string>): string | null {
  if (!hasOnly(attributes, ["at", "format"])) return null;
  const at = attributes.get("at");
  const format = attributes.get("format");
  if (at === undefined || format === undefined || !TIME_FORMAT_PATTERN.test(format)) return null;
  const unix = momentUnixTime(at);
  return unix === null ? null : `<${TIME_NAME} unix="${unix}" format="${format}">`;
}

export function canonicalTelegramRichTag(tag: string): string | null {
  const parsed = parseTag(tag);
  if (parsed === null) return null;
  const { attributes, closing, name, selfClosing } = parsed;
  if (closing) {
    return attributes.size === 0 && !selfClosing && (CONTAINER_NAMES.has(name) || name === TIME_NAME) ? `</${name}>` : null;
  }
  if (CONTAINER_NAMES.has(name)) return attributes.size === 0 && !selfClosing ? `<${name}>` : null;
  if (name === MAP_NAME) return canonicalMap(attributes);
  if (name === TIME_NAME) return selfClosing ? null : canonicalTime(attributes);
  return null;
}

export function isCanonicalTelegramRichMoment(tag: string): boolean {
  return CANONICAL_MOMENT_PATTERN.test(tag);
}

export function isSelfClosingTelegramRichTag(canonical: string): boolean {
  return canonical.startsWith(`<${MAP_NAME} `);
}

function insideCode(index: number, code: readonly { end: number; start: number }[]): boolean {
  return code.some((range) => index >= range.start && index < range.end);
}

function refusedTagLine(tag: string): string {
  const name = parseTag(tag)?.name ?? tag.slice(1).replace(/[\s/>].*$/su, "").toLowerCase();
  if (name === TIME_NAME) {
    return `- ${tag}: write a moment as at="YYYY-MM-DDTHH:MM:SS+HH:MM" with its offset, for example at="2026-11-07T19:00:00+03:00", and format="wt", "Dt", "D", "t" or "r"; never unix.`;
  }
  if (name === MAP_NAME) {
    return `- ${tag}: a map takes only lat from -90 to 90, long from -180 to 180 and an optional whole zoom from 0 to 24, written as <tg-map lat="55.7558" long="37.6173" zoom="15"/>.`;
  }
  return `- ${tag}: <tg-collage> and <tg-slideshow> take no attributes.`;
}

/** What is wrong with the Telegram tags of an answer, for the model, or undefined when nothing is. */
export function telegramRichTagsNotice(markdown: string): string | undefined {
  const code = markdownCodeRanges(readMarkdownTree(markdown));
  const lines = new Set<string>();
  const open: Array<{ end: number; name: string }> = [];
  for (const match of markdown.matchAll(SCANNED_TAG_PATTERN)) {
    if (insideCode(match.index, code)) continue;
    const canonical = canonicalTelegramRichTag(match[0]);
    if (canonical === null) {
      lines.add(refusedTagLine(match[0]));
      continue;
    }
    if (isSelfClosingTelegramRichTag(canonical)) continue;
    const name = canonical.slice(canonical.startsWith("</") ? 2 : 1).replace(/[\s>].*$/su, "");
    if (!canonical.startsWith("</")) {
      open.push({ end: match.index + match[0].length, name });
      continue;
    }
    const opening = open.pop();
    if (opening?.name !== name) {
      lines.add(`- </${name}> has no opening <${name}> before it.`);
      if (opening !== undefined) open.push(opening);
      continue;
    }
    if (name === TIME_NAME && markdown.slice(opening.end, match.index).trim().length === 0) {
      lines.add("- Write the moment as the person reads it as text inside <tg-time>...</tg-time>: it shows where the time cannot be shown.");
    }
  }
  for (const unclosed of open) lines.add(`- <${unclosed.name}> is not closed: end it with </${unclosed.name}>.`);
  if (lines.size === 0) return undefined;
  return [
    "Your answer was not delivered: some Telegram tags in it are wrong.",
    ...lines,
    "Write the whole answer again with these fixed or removed. Do not mention this notice.",
  ].join("\n");
}

export function separateTelegramRichContainers(markdown: string): string {
  const code = markdownCodeRanges(readMarkdownTree(markdown));
  let separated = "";
  let position = 0;
  let afterTag = false;
  const appendText = (text: string) => {
    if (!afterTag) {
      separated += text;
      return;
    }
    const rest = text.replace(/^[ \t\n]*/u, "");
    if (rest.length > 0) separated += `\n\n${rest}`;
    afterTag = rest.length === 0;
  };
  for (const match of markdown.matchAll(CONTAINER_TAG_PATTERN)) {
    if (insideCode(match.index, code)) continue;
    appendText(markdown.slice(position, match.index));
    separated = separated.replace(/[ \t\n]*$/u, "");
    separated += `${separated.length === 0 ? "" : "\n\n"}${match[0]}`;
    position = match.index + match[0].length;
    afterTag = true;
  }
  appendText(markdown.slice(position));
  return separated;
}
