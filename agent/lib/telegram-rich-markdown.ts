/**
 * Safe model-authored Telegram Rich Markdown.
 *
 * Exports:
 * - `sanitizeTelegramRichMarkdown`: preserves text-rich structure and neutralizes active content.
 * - `formatTelegramRichMessages`: produces complete blocks within Telegram's rich text limit, with
 *   the model's line breaks kept as hard breaks.
 * - `hasTelegramRichDetailsBlock`: recognizes an actual supported details container outside code.
 * - `fitsTelegramRichMessage`: whether finished markdown stays within one rich message's limits.
 *
 * Key constructs:
 * - Code is found by a real Markdown parser (`markdown-syntax.ts`), exactly where Telegram shows it
 *   as code, and is the only text left verbatim. Links and media are settled by
 *   `telegram-rich-links.ts` before anything else.
 * - Only `<` is escaped: every tag and autolink starts with it, while `>` also marks a quotation
 *   that must stay one.
 * - A narrow HTML allowlist for details and inline text formatting.
 * - Canonical rewriting of tolerated tag spellings so one stray space never escapes a block.
 * - Recovery of a truncated collapsible block; other malformed allowed tags render inert.
 * - Explicit rejection of over-wide tables, excessive nesting, and indivisible long blocks.
 * - Telegram's own `tg-` tags never pass, not even from what looks like code: an indented line or an
 *   escaped backtick is code here but live HTML to Telegram, and a `tg-button` there could be a
 *   link or mini-app button a page talked the model into. A zero-width space breaks such a tag
 *   while code keeps showing the same characters.
 */
import { AppError } from "./app-error.js";
import { nextFenceState, type FenceState } from "./markdown-code-fence.js";
import { markdownCodeRanges, openTrailingFence, readMarkdownTree, trustedCodeRanges } from "./markdown-syntax.js";
import { keepTelegramRichLineBreaks } from "./telegram-rich-line-breaks.js";
import { inertLinkSyntax, neutralizeTelegramRichLinks } from "./telegram-rich-links.js";
import {
  estimateTelegramRichBlocks,
  splitTelegramRichBlockByCount,
  TELEGRAM_RICH_MESSAGE_MAX_BLOCKS,
} from "./telegram-rich-block-limits.js";

const TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS = 32_768;
const TELEGRAM_RICH_MESSAGE_MAX_TABLE_COLUMNS = 20;
const TELEGRAM_RICH_MESSAGE_MAX_NESTING = 16;
const PLACEHOLDER_START = 0xE000;
const PLACEHOLDER_END = 0xF8FF;
const ALLOWED_HTML_TAG_NAMES = new Set(["details", "summary", "u", "ins", "sub", "sup"]);
const DETAILS_TAG_NAME = "details";
// The tag name stays attached to the bracket so ordinary text like `< details>` is never revived
// as markup; only the attribute area and the closing bracket tolerate stray whitespace.
const HTML_OPEN_TAG_PATTERN = /^<([a-z]+)((?:\s[^<>]*)?)>$/iu;
const HTML_CLOSE_TAG_PATTERN = /^<\/([a-z]+)\s*>$/iu;
// Telegram documents exactly one attribute for a rich collapsible block: `open`.
const DETAILS_OPEN_ATTRIBUTE_PATTERN = /^open(?:\s*=\s*"(?:|open|true)")?$/iu;
const TELEGRAM_TAG_START_PATTERN = /<(\/?tg-)/giu;
const ZERO_WIDTH_SPACE = "\u200B";
// A text settles in one or two readings; more mean a change keeps opening something new.
const MAX_SANITIZE_PASSES = 8;

function placeholderMarker(value: string): string {
  for (let codePoint = PLACEHOLDER_START; codePoint <= PLACEHOLDER_END; codePoint += 1) {
    const marker = String.fromCodePoint(codePoint);
    if (!value.includes(marker)) return marker;
  }
  throw new AppError(
    "AGENT_TELEGRAM_RICH_PLACEHOLDER_UNAVAILABLE",
    "Не удалось безопасно подготовить форматирование ответа",
  );
}

function htmlTagName(tag: string): { closing: boolean; name: string } {
  const match = /^<(\/)?([a-z]+)/u.exec(tag);
  if (!match) {
    throw new AppError(
      "AGENT_TELEGRAM_RICH_HTML_INVALID",
      "Ответ содержит некорректную разрешённую разметку",
    );
  }
  return { closing: match[1] === "/", name: match[2]! };
}

/**
 * Model output varies in spelling (`<details open="true">`, `<summary >`, `</DETAILS>`), while the
 * chunker and Telegram both expect one canonical form. Recognized tags are rewritten; anything with
 * an unexpected attribute stays raw text and is escaped like any other model-authored HTML.
 */
function canonicalAllowedTag(tag: string): string | null {
  const closing = HTML_CLOSE_TAG_PATTERN.exec(tag);
  if (closing) {
    const name = closing[1]!.toLowerCase();
    return ALLOWED_HTML_TAG_NAMES.has(name) ? `</${name}>` : null;
  }

  const opening = HTML_OPEN_TAG_PATTERN.exec(tag);
  if (!opening) return null;
  const name = opening[1]!.toLowerCase();
  if (!ALLOWED_HTML_TAG_NAMES.has(name)) return null;

  const attributes = opening[2]!.trim();
  if (attributes.length === 0) return `<${name}>`;
  if (name === DETAILS_TAG_NAME && DETAILS_OPEN_ATTRIBUTE_PATTERN.test(attributes)) {
    return `<${DETAILS_TAG_NAME} open>`;
  }
  return null;
}

/**
 * Returns the closing tags a truncated answer still needs. A collapsible block is the one container
 * the prompt asks for on a long answer, so an unclosed `<details>` is completed instead of
 * degrading the whole message to escaped text. Any other imbalance stays a hard error.
 */
function validateAllowedTags(tags: readonly string[]): string[] {
  const stack: string[] = [];
  let detailsDepth = 0;

  // Allowed tags must remain structurally balanced so Telegram never receives a partial block.
  for (const tag of tags) {
    const { closing, name } = htmlTagName(tag);
    if (!closing) {
      stack.push(name);
      if (name === DETAILS_TAG_NAME) detailsDepth += 1;
      if (detailsDepth > TELEGRAM_RICH_MESSAGE_MAX_NESTING) {
        throw new AppError(
          "AGENT_TELEGRAM_RICH_NESTING_TOO_DEEP",
          "Ответ содержит слишком много уровней вложенного форматирования",
        );
      }
      continue;
    }

    if (stack.pop() !== name) {
      throw new AppError(
        "AGENT_TELEGRAM_RICH_HTML_INVALID",
        "Ответ содержит несбалансированную разрешённую разметку",
      );
    }
    if (name === DETAILS_TAG_NAME) detailsDepth -= 1;
  }

  // Closing a dangling inline tag would silently restyle the tail; only blocks are recoverable.
  if (stack.some((name) => name !== DETAILS_TAG_NAME)) {
    throw new AppError(
      "AGENT_TELEGRAM_RICH_HTML_INVALID",
      "Ответ содержит незакрытую разрешённую разметку",
    );
  }
  return stack.map(() => `</${DETAILS_TAG_NAME}>`);
}

function protectMarkdownCode(markdown: string): {
  protectedMarkdown: string;
  restore(value: string): string;
} {
  const marker = placeholderMarker(markdown);
  const code: string[] = [];
  let protectedMarkdown = "";
  let position = 0;
  // Only code Telegram is sure to show as code keeps its raw text, found by the parser exactly.
  // Other code is text to Telegram, yet code to the parser: its `<` goes dead right here, so no
  // allowed tag inside it is ever taken for markup.
  const tree = readMarkdownTree(markdown);
  const trusted = trustedCodeRanges(markdown, tree);
  for (const range of markdownCodeRanges(tree)) {
    if (range.start < position) continue;
    const source = markdown.slice(range.start, range.end);
    const kept = trusted.some((code) => code.start === range.start && code.end === range.end)
      ? `${marker}${code.push(source) - 1}${marker}`
      : source.replaceAll("<", "&lt;");
    protectedMarkdown += `${markdown.slice(position, range.start)}${kept}`;
    position = range.end;
  }
  protectedMarkdown += markdown.slice(position);
  return {
    protectedMarkdown,
    restore(value) {
      let restored = value;
      // A function replacement: code is full of `$'`, `$$` and `$&`, which a string one expands.
      for (const [index, codeBlock] of code.entries()) {
        restored = restored.replaceAll(`${marker}${index}${marker}`, () => codeBlock);
      }
      return restored;
    },
  };
}

export function hasTelegramRichDetailsBlock(markdown: string): boolean {
  const protectedCode = protectMarkdownCode(markdown).protectedMarkdown;
  const stack: Array<{ hasSummary: boolean; name: "details" | "summary" }> = [];
  let foundDetails = false;
  for (const match of protectedCode.matchAll(/<[^>\n]*>/gu)) {
    const canonical = canonicalAllowedTag(match[0]);
    const rawName = /^<\/?([a-z]+)/iu.exec(match[0])?.[1]?.toLowerCase();
    if ((rawName === "details" || rawName === "summary") && canonical === null) return false;
    if (canonical === null) continue;
    const { closing, name } = htmlTagName(canonical);
    if (name !== "details" && name !== "summary") continue;
    if (!closing && name === "details") {
      stack.push({ hasSummary: false, name });
      foundDetails = true;
      continue;
    }
    if (!closing && name === "summary") {
      const parent = stack.at(-1);
      if (parent?.name !== "details" || parent.hasSummary) return false;
      parent.hasSummary = true;
      stack.push({ hasSummary: false, name });
      continue;
    }
    const current = stack.pop();
    if (current?.name !== name || (name === "details" && !current.hasSummary)) return false;
  }
  return foundDetails && stack.length === 0;
}

function validateTableWidths(markdown: string): void {
  const lines = markdown.split("\n");
  const tableRows = new Set<number>();
  const delimiter = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u;
  for (const [index, line] of lines.entries()) {
    if (!delimiter.test(line)) continue;
    if (index > 0 && lines[index - 1]!.includes("|")) tableRows.add(index - 1);
    for (let cursor = index; cursor < lines.length && lines[cursor]!.includes("|"); cursor += 1) {
      tableRows.add(cursor);
    }
  }
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    const outerTableRow = trimmed.startsWith("|") && trimmed.endsWith("|");
    if (!outerTableRow && !tableRows.has(index)) continue;
    const columns = trimmed.replace(/^\|/u, "").replace(/\|$/u, "").split("|").length;
    if (columns > TELEGRAM_RICH_MESSAGE_MAX_TABLE_COLUMNS) {
      throw new AppError(
        "AGENT_TELEGRAM_RICH_TABLE_TOO_WIDE",
        `Таблица в ответе содержит больше ${TELEGRAM_RICH_MESSAGE_MAX_TABLE_COLUMNS} столбцов`,
      );
    }
  }
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function completeMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const current: string[] = [];
  let detailsDepth = 0;
  // Every fence Markdown knows (backticks or tildes, any length), so a blank line inside one is
  // never taken for the end of a block: the next message would show that code as live text.
  let fence: FenceState | null = null;
  let mathBlock = false;
  const flush = () => {
    if (current.length === 0) return;
    blocks.push(current.join("\n"));
    current.length = 0;
  };

  // Blank lines inside fenced code, details, and block formulas are content, not split points.
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    const openFence = fence;
    fence = nextFenceState(line, fence);
    if (current.length === 0) {
      if (!trimmed) continue;
      mathBlock = trimmed === "$$";
    } else if (openFence === null && fence === null && detailsDepth === 0 && !mathBlock && !trimmed) {
      flush();
      continue;
    }

    current.push(line);
    const detailsOpen = line.match(/<details(?: open)?>/gu)?.length ?? 0;
    const detailsClose = line.match(/<\/details>/gu)?.length ?? 0;
    detailsDepth += detailsOpen - detailsClose;

    if (openFence !== null && fence === null && detailsDepth === 0 && !mathBlock) {
      flush();
      continue;
    }
    if (mathBlock && current.length > 1 && trimmed === "$$") {
      mathBlock = false;
      flush();
      continue;
    }
    if ((detailsOpen > 0 || detailsClose > 0) && detailsDepth === 0) flush();
  }
  flush();
  return blocks;
}

/**
 * A truncated answer may end inside a code block. Markdown runs it to the end anyway; closing it
 * explicitly changes nothing on screen and lets a missing `</details>` land after the code.
 */
function closeOpenTrailingFence(markdown: string): string {
  const fence = openTrailingFence(markdown, readMarkdownTree(markdown));
  return fence === null ? markdown : `${markdown.replace(/\s+$/u, "")}\n${fence}`;
}

/**
 * Telegram reads Markdown inside a collapsible block, while Markdown itself takes the lines after
 * an HTML tag as raw HTML up to the next blank line, and the filter would see no link there. A
 * blank line after the summary and before the closing tag, the way the prompt asks the model to
 * write the block, makes both read the inside as Markdown.
 */
function separateDetailsContent(text: string, marker: string, tags: readonly string[]): string {
  let separated = text;
  for (const [index, tag] of tags.entries()) {
    const placeholder = `${marker}${index}${marker}`;
    const at = separated.indexOf(placeholder);
    if (at === -1) continue;
    const before = separated.slice(0, at);
    const after = separated.slice(at + placeholder.length);
    if (tag === "</summary>" && !/^[ \t]*\n[ \t]*\n/u.test(after)) {
      separated = `${before}${placeholder}\n\n${after.replace(/^[ \t]*\n?/u, "")}`;
    } else if (tag === `</${DETAILS_TAG_NAME}>` && before.trim() !== "" && !/\n[ \t]*\n[ \t]*$/u.test(before)) {
      separated = `${before.replace(/\n?[ \t]*$/u, "")}\n\n${placeholder}${after}`;
    }
  }
  return separated;
}

/** One reading of the text: every tag outside code goes dead except the allowed ones. */
function escapeLiveTags(markdown: string, preserveAllowedHtml: boolean): string {
  const protectedCode = protectMarkdownCode(markdown);
  validateTableWidths(protectedCode.protectedMarkdown);

  // Rich Markdown accepts arbitrary HTML and remote media, so reserve only reviewed text tags.
  const marker = placeholderMarker(protectedCode.protectedMarkdown);
  const allowedTags: string[] = [];
  let sanitized = protectedCode.protectedMarkdown.replace(/<[^>\n]*>/gu, (tag) => {
    if (!preserveAllowedHtml) return tag;
    const canonical = canonicalAllowedTag(tag);
    if (canonical === null) return tag;
    const index = allowedTags.push(canonical) - 1;
    return `${marker}${index}${marker}`;
  });
  const missingClosingTags = validateAllowedTags(allowedTags);
  sanitized = separateDetailsContent(sanitized, marker, allowedTags);

  // Every other tag goes dead; a lone `>` cannot open one and may mark a quotation.
  sanitized = sanitized.replaceAll("<", "&lt;");

  for (const [index, tag] of allowedTags.entries()) {
    sanitized = sanitized.replaceAll(`${marker}${index}${marker}`, () => tag);
  }

  // A recovered closing tag belongs on its own block line so chunking still sees complete blocks.
  if (missingClosingTags.length > 0) {
    sanitized = `${sanitized.trimEnd()}\n\n${missingClosingTags.join("\n\n")}`;
  }
  return protectedCode.restore(sanitized);
}

function sanitizeTelegramRichMarkdownInternal(
  markdown: string,
  preserveAllowedHtml: boolean,
): string {
  // Each step changes how the rest reads: a refused link turns into text, and an escaped `<` can
  // let a bare web address run on into a code span and open what the span kept inert. So the
  // steps repeat on their own result until a reading changes nothing. They only ever make text
  // inert, never live again, so the readings settle.
  let text = markdown;
  for (let pass = 0; pass < MAX_SANITIZE_PASSES; pass += 1) {
    // A step can leave a fence open at the end (a blank line moved it onto a line of its own), so
    // each reading closes it before a missing `</details>` is added after it.
    const next = escapeLiveTags(neutralizeTelegramRichLinks(closeOpenTrailingFence(text)), preserveAllowedHtml);
    if (next === text) return next.replace(TELEGRAM_TAG_START_PATTERN, `<${ZERO_WIDTH_SPACE}$1`);
    text = next;
  }
  // A text crafted to keep changing still goes out, all of it inert: every `<` escaped, code
  // included, and no link syntax left.
  console.error(JSON.stringify({ code: "AGENT_TELEGRAM_RICH_UNSETTLED" }));
  return inertLinkSyntax(text).replaceAll("<", "&lt;");
}

export function sanitizeTelegramRichMarkdown(markdown: string): string {
  try {
    return sanitizeTelegramRichMarkdownInternal(markdown, true);
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      error.code !== "AGENT_TELEGRAM_RICH_HTML_INVALID"
    ) {
      throw error;
    }

    // Model-authored formatting must not suppress an otherwise valid answer.
    return sanitizeTelegramRichMarkdownInternal(markdown, false);
  }
}

function hardSplit(value: string, maxCharacters: number): string[] {
  const characters = Array.from(value);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += maxCharacters) {
    chunks.push(characters.slice(offset, offset + maxCharacters).join(""));
  }
  return chunks;
}

function splitBodyBlock(block: string, maxCharacters: number): string[] {
  if (characterLength(block) <= maxCharacters) return [block];
  const lines = block.split("\n");
  const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(lines[0]!)?.[1];
  const closing = lines.at(-1)!.trim();
  if (fence === undefined || lines.length < 3 || closing.length < fence.length || closing !== fence[0]!.repeat(closing.length)) {
    return hardSplit(block, maxCharacters);
  }

  // Reopen a very large code fence in each message, with its own opening and closing lines, so
  // every rich payload remains valid Markdown.
  const opening = lines[0]!;
  const closingLine = lines.at(-1)!;
  const overhead = characterLength(`${opening}\n\n${closingLine}`);
  const contentLimit = maxCharacters - overhead;
  if (contentLimit < 1) return [];
  return hardSplit(lines.slice(1, -1).join("\n"), contentLimit).map((part) => `${opening}\n${part}\n${closingLine}`);
}

function splitOversizedDetailsBlock(block: string): string[] | null {
  // Trailing spaces are a hard break the line-break step may leave after the frame's lines.
  const match = /^(<details(?: open)?><summary>[^\n]*<\/summary>)[ \t]*\n+([\s\S]*?)[ \t]*\n+<\/details>$/u.exec(block);
  if (!match) return null;
  const opening = match[1]!;
  const body = match[2]!;
  if (body.includes("<details") || body.includes("</details>")) return null;

  const overhead = characterLength(`${opening}\n\n\n\n</details>`);
  const bodyLimit = TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS - overhead;
  const bodyBlockLimit = TELEGRAM_RICH_MESSAGE_MAX_BLOCKS - 3;
  const bodyBlocks = completeMarkdownBlocks(body)
    .flatMap((item) => splitTelegramRichBlockByCount(item, bodyBlockLimit))
    .flatMap((item) => splitBodyBlock(item, bodyLimit));
  if (bodyBlocks.length === 0) return null;

  const bodyChunks: string[] = [];
  let current = "";
  for (const bodyBlock of bodyBlocks) {
    const candidate = current ? `${current}\n\n${bodyBlock}` : bodyBlock;
    if (characterLength(candidate) <= bodyLimit &&
      estimateTelegramRichBlocks(candidate) <= bodyBlockLimit) {
      current = candidate;
      continue;
    }
    if (current) bodyChunks.push(current);
    current = bodyBlock;
  }
  if (current) bodyChunks.push(current);
  return bodyChunks.map((part) => `${opening}\n\n${part}\n\n</details>`);
}

export function fitsTelegramRichMessage(markdown: string): boolean {
  return characterLength(markdown) <= TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS &&
    estimateTelegramRichBlocks(markdown) <= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS;
}

export function formatTelegramRichMessages(markdown: string): string[] {
  // The model's line breaks are part of what it wrote; Telegram would read most of them as spaces.
  const sanitized = keepTelegramRichLineBreaks(sanitizeTelegramRichMarkdown(markdown).trim());
  if (!sanitized) return [];
  if (characterLength(sanitized) <= TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS &&
    estimateTelegramRichBlocks(sanitized) <= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) return [sanitized];

  // Split only between complete Markdown blocks so every independently parsed message stays valid.
  const blocks = completeMarkdownBlocks(sanitized).flatMap((block) => {
    if (characterLength(block) <= TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS &&
      estimateTelegramRichBlocks(block) <= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) return [block];
    const details = splitOversizedDetailsBlock(block);
    if (details !== null) return details;
    if (estimateTelegramRichBlocks(block) > TELEGRAM_RICH_MESSAGE_MAX_BLOCKS && !hasTelegramRichDetailsBlock(block)) {
      return splitTelegramRichBlockByCount(block, TELEGRAM_RICH_MESSAGE_MAX_BLOCKS);
    }
    // A single code block longer than one message is reopened in each part, like inside details;
    // any other indivisible block stays whole and fails explicitly below.
    return /^ {0,3}(?:`{3,}|~{3,})/u.test(block) ? splitBodyBlock(block, TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS) : [block];
  });
  const chunks: string[] = [];
  let chunk = "";
  for (const block of blocks) {
    if (characterLength(block) > TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS ||
      estimateTelegramRichBlocks(block) > TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) {
      throw new AppError(
        "AGENT_TELEGRAM_RICH_BLOCK_TOO_LONG",
        "Один блок ответа превышает допустимый размер или число блоков Telegram",
      );
    }
    const candidate = chunk ? `${chunk}\n\n${block}` : block;
    if (characterLength(candidate) <= TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS &&
      estimateTelegramRichBlocks(candidate) <= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) {
      chunk = candidate;
      continue;
    }
    chunks.push(chunk);
    chunk = block;
  }
  if (chunk) chunks.push(chunk);
  // Telegram reads each message on its own. Whatever a cut changed about where code begins or
  // ends, every message passes the filter once more, and still has to fit.
  if (chunks.length < 2) return chunks;
  return chunks.map((part) => {
    const checked = sanitizeTelegramRichMarkdown(part);
    if (!fitsTelegramRichMessage(checked)) {
      throw new AppError(
        "AGENT_TELEGRAM_RICH_BLOCK_TOO_LONG",
        "Один блок ответа превышает допустимый размер или число блоков Telegram",
      );
    }
    return checked;
  });
}
