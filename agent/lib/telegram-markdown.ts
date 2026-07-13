/**
 * Safe model Markdown delivery for Telegram.
 *
 * Exports:
 * - `renderTelegramMarkdownHtml`: converts the supported Markdown subset to Telegram HTML.
 * - `formatTelegramMarkdown`: returns balanced HTML chunks within Telegram's text limit.
 * - `formatTelegramMarkdownDraft`: returns one balanced native draft preview.
 * - `postTelegramMarkdown`: posts every chunk with explicit Telegram HTML parsing.
 */
import type { TelegramMessageBody } from "eve/channels/telegram";

const TELEGRAM_MESSAGE_MAX_CHARACTERS = 4_096;
const TELEGRAM_LINK_MAX_CHARACTERS = 2_048;
const REPEATED_EMOJI_MINIMUM = 8;
const INLINE_PLACEHOLDER_START = 0xE000;
const INLINE_PLACEHOLDER_END = 0xF8FF;
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tg:"]);
const HTML_TOKEN_PATTERN =
  /<(?:b|i|s|code|pre|blockquote|a href="[^"]+")>|<\/(?:b|i|s|code|pre|blockquote|a)>|&(?:amp|lt|gt|quot|#39);|[\s\S]/gu;

interface TelegramHtmlMessageBody extends TelegramMessageBody {
  readonly parse_mode: "HTML";
}

interface TelegramPoster {
  post(message: TelegramHtmlMessageBody): Promise<unknown>;
}

interface OpenHtmlTag {
  close: string;
  name: string;
  open: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function placeholderMarker(value: string): string {
  for (let codePoint = INLINE_PLACEHOLDER_START; codePoint <= INLINE_PLACEHOLDER_END; codePoint += 1) {
    const marker = String.fromCodePoint(codePoint);
    if (!value.includes(marker)) return marker;
  }
  throw new Error("AGENT_TELEGRAM_MARKDOWN_PLACEHOLDER_UNAVAILABLE: Input exhausts reserved markers");
}

function safeLink(rawUrl: string): string | null {
  if (rawUrl.length > TELEGRAM_LINK_MAX_CHARACTERS) return null;
  if (!URL.canParse(rawUrl)) return null;
  const url = new URL(rawUrl);
  if (!ALLOWED_LINK_PROTOCOLS.has(url.protocol)) return null;

  // Escaping can expand ampersands enough to make the indivisible opening tag invalid.
  const escaped = escapeHtml(rawUrl);
  if (`<a href="${escaped}"></a>`.length >= TELEGRAM_MESSAGE_MAX_CHARACTERS) return null;
  return escaped;
}

function collapseRepeatedEmoji(value: string): string {
  const repeated = new RegExp(
    `(\\p{Extended_Pictographic}(?:\\uFE0E|\\uFE0F)?)(?:[ \\t]*\\1){${REPEATED_EMOJI_MINIMUM - 1},}`,
    "gu",
  );
  return value.replace(repeated, (match, emoji: string) => {
    const count = match.match(/\p{Extended_Pictographic}/gu)!.length;
    return `${emoji} × ${count}`;
  });
}

function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const body = trimmed.replace(/^\|/u, "").replace(/\|$/u, "");
  const cells = body.split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells !== null && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function renderInline(markdown: string): string {
  const marker = placeholderMarker(markdown);
  const replacements: string[] = [];
  const reserve = (html: string): string => {
    const index = replacements.push(html) - 1;
    return `${marker}${index}${marker}`;
  };

  // Protect code and validated links before escaping and interpreting emphasis markers.
  let source = markdown.replace(/`([^`\n]+)`/gu, (_match, code: string) =>
    reserve(`<code>${escapeHtml(code)}</code>`)
  );
  source = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (match, label: string, url: string) => {
    const href = safeLink(url);
    return href === null ? match : reserve(`<a href="${href}">${renderInline(label)}</a>`);
  });
  source = collapseRepeatedEmoji(source);

  let html = escapeHtml(source);
  html = html.replace(/\*\*([^*\n]+)\*\*/gu, "<b>$1</b>");
  html = html.replace(/__([^_\n]+)__/gu, "<b>$1</b>");
  html = html.replace(/~~([^~\n]+)~~/gu, "<s>$1</s>");
  html = html.replace(
    /(^|[^\p{L}\p{N}])\*([^*\n]+)\*(?=$|[^\p{L}\p{N}])/gu,
    "$1<i>$2</i>",
  );
  html = html.replace(
    /(^|[^\p{L}\p{N}])_([^_\n]+)_(?=$|[^\p{L}\p{N}])/gu,
    "$1<i>$2</i>",
  );

  // Restore only placeholders created by this invocation; raw model HTML remains escaped.
  for (const [index, replacement] of replacements.entries()) {
    html = html.replaceAll(`${marker}${index}${marker}`, replacement);
  }
  return html;
}

function isSpecialBlockStart(line: string): boolean {
  return /^```/u.test(line) || /^#{1,6}\s+/u.test(line) || /^>\s?/u.test(line) ||
    /^(?:[-+*]|\d+\.)\s+/u.test(line);
}

export function renderTelegramMarkdownHtml(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const blocks: string[] = [];

  // Render block constructs first so inline markers cannot alter Telegram tags.
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (/^```/u.test(line)) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index]!)) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }
    const headerCells = tableCells(line);
    if (headerCells && index + 1 < lines.length && isTableSeparator(lines[index + 1]!)) {
      const rows = [headerCells];
      index += 2;
      while (index < lines.length) {
        const cells = tableCells(lines[index]!);
        if (!cells || isTableSeparator(lines[index]!)) break;
        rows.push(cells);
        index += 1;
      }
      const table = rows
        .map((cells) => cells.map(collapseRepeatedEmoji).join(" | "))
        .join("\n");
      blocks.push(`<pre>${escapeHtml(table)}</pre>`);
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) {
      blocks.push(`<b>${renderInline(heading[1]!)}</b>`);
      index += 1;
      continue;
    }
    if (/^>\s?/u.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index]!)) {
        quoteLines.push(lines[index]!.replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderInline(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^(?:[-+*]|\d+\.)\s+/u.test(line)) {
      const listLines: string[] = [];
      while (index < lines.length && /^(?:[-+*]|\d+\.)\s+/u.test(lines[index]!)) {
        const item = lines[index]!;
        const unordered = /^[-+*]\s+(.+)$/u.exec(item);
        listLines.push(unordered ? `• ${renderInline(unordered[1]!)}` : renderInline(item));
        index += 1;
      }
      blocks.push(listLines.join("\n"));
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim().length > 0 &&
      !isSpecialBlockStart(lines[index]!)
    ) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    blocks.push(renderInline(paragraph.join("\n")));
  }
  return blocks.join("\n\n");
}

function openingTag(token: string): OpenHtmlTag | null {
  const match = /^<([a-z]+)(?:\s[^>]*)?>$/u.exec(token);
  if (!match) return null;
  return { close: `</${match[1]!}>`, name: match[1]!, open: token };
}

function closingTagName(token: string): string | null {
  return /^<\/([a-z]+)>$/u.exec(token)?.[1] ?? null;
}

function splitTelegramHtml(html: string, maxCharacters: number): string[] {
  if (html.length === 0) return [];
  const tokens = html.match(HTML_TOKEN_PATTERN) ?? [];
  const chunks: string[] = [];
  const stack: OpenHtmlTag[] = [];
  let chunk = "";

  const closingSuffix = () => stack.slice().reverse().map((tag) => tag.close).join("");
  const flush = () => {
    if (chunk.length === 0) return;
    chunks.push(chunk + closingSuffix());
    chunk = stack.map((tag) => tag.open).join("");
  };

  // Reserve room for closing tags before each token; reopened tags preserve formatting per chunk.
  for (const token of tokens) {
    const open = openingTag(token);
    if (open) {
      if (chunk.length + token.length + open.close.length + closingSuffix().length > maxCharacters) {
        flush();
      }
      chunk += token;
      stack.push(open);
      continue;
    }
    const closeName = closingTagName(token);
    if (closeName) {
      const current = stack.at(-1);
      if (!current || current.name !== closeName) {
        throw new Error("AGENT_TELEGRAM_MARKDOWN_HTML_INVALID: Renderer produced unbalanced HTML");
      }
      chunk += token;
      stack.pop();
      continue;
    }
    if (chunk.length + token.length + closingSuffix().length > maxCharacters) {
      flush();
    }
    chunk += token;
  }
  if (stack.length !== 0) {
    throw new Error("AGENT_TELEGRAM_MARKDOWN_HTML_INVALID: Renderer produced unbalanced HTML");
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export function formatTelegramMarkdown(markdown: string): string[] {
  return splitTelegramHtml(renderTelegramMarkdownHtml(markdown), TELEGRAM_MESSAGE_MAX_CHARACTERS);
}

export function formatTelegramMarkdownDraft(markdown: string): string | null {
  const chunks = formatTelegramMarkdown(markdown);
  return chunks.length === 1 ? chunks[0]! : null;
}

export async function postTelegramMarkdown(
  telegram: TelegramPoster,
  markdown: string,
): Promise<void> {
  for (const text of formatTelegramMarkdown(markdown)) {
    await telegram.post({ parse_mode: "HTML", text });
  }
}
