/**
 * Safe model-authored Telegram Rich Markdown.
 *
 * Exports:
 * - `sanitizeTelegramRichMarkdown`: preserves text-rich structure and neutralizes active content.
 * - `formatTelegramRichMessages`: produces complete blocks within Telegram's rich text limit.
 * - `formatTelegramRichMessageDraft`: returns one valid ephemeral preview or `null` when too long.
 *
 * Key constructs:
 * - A narrow HTML allowlist for details and inline text formatting.
 * - Explicit rejection of over-wide tables, malformed allowed tags, and indivisible long blocks.
 */
import { AppError } from "./app-error.js";

const TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS = 32_768;
const TELEGRAM_RICH_MESSAGE_MAX_TABLE_COLUMNS = 20;
const TELEGRAM_RICH_MESSAGE_MAX_NESTING = 16;
const PLACEHOLDER_START = 0xE000;
const PLACEHOLDER_END = 0xF8FF;
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const ALLOWED_HTML_TAG_PATTERN =
  /^<(?:details(?: open)?|summary|u|ins|sub|sup)>$|^<\/(?:details|summary|u|ins|sub|sup)>$/u;
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\n]*\))+)\)/gu;

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

function validateAllowedTags(tags: readonly string[]): void {
  const stack: string[] = [];
  let detailsDepth = 0;

  // Allowed tags must remain structurally balanced so Telegram never receives a partial block.
  for (const tag of tags) {
    const { closing, name } = htmlTagName(tag);
    if (!closing) {
      stack.push(name);
      if (name === "details") detailsDepth += 1;
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
    if (name === "details") detailsDepth -= 1;
  }

  if (stack.length !== 0) {
    throw new AppError(
      "AGENT_TELEGRAM_RICH_HTML_INVALID",
      "Ответ содержит незакрытую разрешённую разметку",
    );
  }
}

function safeMarkdownLink(rawUrl: string): boolean {
  if (/^#[\p{L}\p{N}_.:-]+$/u.test(rawUrl)) return true;
  if (!URL.canParse(rawUrl)) return false;
  return ALLOWED_LINK_PROTOCOLS.has(new URL(rawUrl).protocol);
}

function neutralizeUnsafeLinks(markdown: string): string {
  return markdown.replace(
    MARKDOWN_LINK_PATTERN,
    (match, label: string, rawUrl: string) =>
      safeMarkdownLink(rawUrl) ? match : `${label} (${rawUrl})`,
  );
}

function validateTableWidths(markdown: string): void {
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const columns = trimmed.slice(1, -1).split("|").length;
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
  validateTableWidths(markdown);

  // Rich Markdown accepts arbitrary HTML and remote media, so reserve only reviewed text tags.
  const marker = placeholderMarker(markdown);
  const allowedTags: string[] = [];
  let sanitized = markdown.replace(/<[^>\n]*>/gu, (tag) => {
    if (!preserveAllowedHtml || !ALLOWED_HTML_TAG_PATTERN.test(tag)) return tag;
    const index = allowedTags.push(tag) - 1;
    return `${marker}${index}${marker}`;
  });
  validateAllowedTags(allowedTags);

  // Model-authored media and unsafe links stay visible as inert text instead of triggering fetches.
  sanitized = sanitized.replace(/!\[/gu, "\\![");
  sanitized = neutralizeUnsafeLinks(sanitized);
  sanitized = sanitized.replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  for (const [index, tag] of allowedTags.entries()) {
    sanitized = sanitized.replaceAll(`${marker}${index}${marker}`, tag);
  }
  return sanitized;
}

export function sanitizeTelegramRichMarkdown(markdown: string): string {
  return sanitizeTelegramRichMarkdownInternal(markdown, true);
}

export function formatTelegramRichMessages(markdown: string): string[] {
  const sanitized = sanitizeTelegramRichMarkdown(markdown).trim();
  if (!sanitized) return [];
  if (characterLength(sanitized) <= TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS) return [sanitized];

  // Split only between complete Markdown blocks so every independently parsed message stays valid.
  const blocks = completeMarkdownBlocks(sanitized);
  const chunks: string[] = [];
  let chunk = "";
  for (const block of blocks) {
    if (characterLength(block) > TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS) {
      throw new AppError(
        "AGENT_TELEGRAM_RICH_BLOCK_TOO_LONG",
        "Один блок ответа превышает допустимый размер Telegram. Сократите его или разделите на части",
      );
    }
    const candidate = chunk ? `${chunk}\n\n${block}` : block;
    if (characterLength(candidate) <= TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS) {
      chunk = candidate;
      continue;
    }
    chunks.push(chunk);
    chunk = block;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function formatTelegramRichMessageDraft(markdown: string): string | null {
  let sanitized: string;
  try {
    sanitized = sanitizeTelegramRichMarkdown(markdown).trim();
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "AGENT_TELEGRAM_RICH_HTML_INVALID") {
      throw error;
    }
    // Stream deltas can end midway through an allowed tag; show it inert until the block closes.
    sanitized = sanitizeTelegramRichMarkdownInternal(markdown, false).trim();
  }
  if (!sanitized || characterLength(sanitized) > TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS) return null;
  return sanitized;
}
