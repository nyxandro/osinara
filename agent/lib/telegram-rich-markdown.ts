/**
 * Safe model-authored Telegram Rich Markdown.
 *
 * Exports:
 * - `sanitizeTelegramRichMarkdown`: preserves text-rich structure and neutralizes active content.
 * - `formatTelegramRichMessages`: produces complete blocks within Telegram's rich text limit.
 * - `hasTelegramRichDetailsBlock`: recognizes an actual supported details container outside code.
 * - `fitsTelegramRichMessage`: whether finished markdown stays within one rich message's limits.
 *
 * Key constructs:
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
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
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
 * the prompt asks for on every long answer, so an unclosed `<details>` is completed instead of
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

function safeMarkdownLink(rawUrl: string): boolean {
  if (/^#[\p{L}\p{N}_.:-]+$/u.test(rawUrl)) return true;
  if (!URL.canParse(rawUrl)) return false;
  return ALLOWED_LINK_PROTOCOLS.has(new URL(rawUrl).protocol);
}

function neutralizeUnsafeLinks(markdown: string): string {
  let result = "";
  let offset = 0;
  while (offset < markdown.length) {
    const labelStart = markdown.indexOf("[", offset);
    if (labelStart === -1) return result + markdown.slice(offset);
    const labelEnd = markdown.indexOf("](", labelStart + 1);
    if (labelEnd === -1 || markdown.slice(labelStart + 1, labelEnd).includes("\n")) {
      result += markdown.slice(offset, labelStart + 1);
      offset = labelStart + 1;
      continue;
    }

    // Markdown destinations may contain balanced nested parentheses; regex-only matching leaves
    // deeper unsafe URLs untouched, so scan the destination structurally.
    let depth = 1;
    let cursor = labelEnd + 2;
    for (; cursor < markdown.length && depth > 0; cursor += 1) {
      const character = markdown[cursor]!;
      if (character === "\\") {
        cursor += 1;
        continue;
      }
      if (character === "\n" || /\s/u.test(character)) break;
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
    }
    if (depth !== 0) {
      result += markdown.slice(offset, labelStart + 1);
      offset = labelStart + 1;
      continue;
    }

    const matchEnd = cursor;
    const label = markdown.slice(labelStart + 1, labelEnd);
    const rawUrl = markdown.slice(labelEnd + 2, matchEnd - 1);
    const match = markdown.slice(labelStart, matchEnd);
    result += markdown.slice(offset, labelStart);
    result += safeMarkdownLink(rawUrl) ? match : `${label} (${rawUrl})`;
    offset = matchEnd;
  }
  return result;
}

function protectMarkdownCode(markdown: string): {
  protectedMarkdown: string;
  restore(value: string): string;
} {
  const marker = placeholderMarker(markdown);
  const code: string[] = [];
  // Complete inline spans and fenced blocks are inert Markdown content; an unfinished fence is
  // protected to the end because model truncation must not turn code examples into active HTML.
  const protectedMarkdown = markdown.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/gu, (value) => {
    const index = code.push(value) - 1;
    return `${marker}${index}${marker}`;
  });
  return {
    protectedMarkdown,
    restore(value) {
      let restored = value;
      for (const [index, codeBlock] of code.entries()) {
        restored = restored.replaceAll(`${marker}${index}${marker}`, codeBlock);
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
  let fencedCode = false;
  let mathBlock = false;
  const flush = () => {
    if (current.length === 0) return;
    blocks.push(current.join("\n"));
    current.length = 0;
  };

  // Blank lines inside fenced code, details, and block formulas are content, not split points.
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (current.length === 0) {
      if (!trimmed) continue;
      fencedCode = /^```/u.test(trimmed);
      mathBlock = trimmed === "$$";
    } else if (!fencedCode && detailsDepth === 0 && !mathBlock && !trimmed) {
      flush();
      continue;
    }

    current.push(line);
    const detailsOpen = line.match(/<details(?: open)?>/gu)?.length ?? 0;
    const detailsClose = line.match(/<\/details>/gu)?.length ?? 0;
    detailsDepth += detailsOpen - detailsClose;

    if (fencedCode && current.length > 1 && /^```\s*$/u.test(trimmed)) {
      fencedCode = false;
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

function sanitizeTelegramRichMarkdownInternal(
  markdown: string,
  preserveAllowedHtml: boolean,
): string {
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

  // Model-authored media and unsafe links stay visible as inert text instead of triggering fetches.
  sanitized = sanitized.replace(/!\[/gu, "\\![");
  sanitized = neutralizeUnsafeLinks(sanitized);
  sanitized = sanitized.replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  for (const [index, tag] of allowedTags.entries()) {
    sanitized = sanitized.replaceAll(`${marker}${index}${marker}`, tag);
  }

  // A recovered closing tag belongs on its own block line so chunking still sees complete blocks.
  if (missingClosingTags.length > 0) {
    sanitized = `${sanitized.trimEnd()}\n\n${missingClosingTags.join("\n\n")}`;
  }
  return protectedCode.restore(sanitized).replace(TELEGRAM_TAG_START_PATTERN, `<${ZERO_WIDTH_SPACE}$1`);
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
  const fenced = /^```([^\n]*)\n([\s\S]*)\n```$/u.exec(block);
  if (!fenced) return hardSplit(block, maxCharacters);

  // Reopen a very large code fence in each message so every rich payload remains valid Markdown.
  const opening = `\`\`\`${fenced[1]}`;
  const overhead = characterLength(`${opening}\n\n\`\`\``);
  const contentLimit = maxCharacters - overhead;
  if (contentLimit < 1) return [];
  return hardSplit(fenced[2]!, contentLimit).map((part) => `${opening}\n${part}\n\`\`\``);
}

function splitOversizedDetailsBlock(block: string): string[] | null {
  const match = /^(<details(?: open)?><summary>[^\n]*<\/summary>)\n+([\s\S]*)\n+<\/details>$/u.exec(block);
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
  const sanitized = sanitizeTelegramRichMarkdown(markdown).trim();
  if (!sanitized) return [];
  if (characterLength(sanitized) <= TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS &&
    estimateTelegramRichBlocks(sanitized) <= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) return [sanitized];

  // Split only between complete Markdown blocks so every independently parsed message stays valid.
  const blocks = completeMarkdownBlocks(sanitized).flatMap((block) => {
    if (characterLength(block) <= TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS &&
      estimateTelegramRichBlocks(block) <= TELEGRAM_RICH_MESSAGE_MAX_BLOCKS) return [block];
    return splitOversizedDetailsBlock(block) ?? (
      estimateTelegramRichBlocks(block) > TELEGRAM_RICH_MESSAGE_MAX_BLOCKS &&
        !hasTelegramRichDetailsBlock(block)
        ? splitTelegramRichBlockByCount(block, TELEGRAM_RICH_MESSAGE_MAX_BLOCKS)
        : [block]
    );
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
  return chunks;
}
