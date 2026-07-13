/**
 * Safe Markdown-to-HTML rendering for Telegram file captions.
 *
 * Export:
 * - `renderTelegramMarkdownHtml`: converts the supported caption subset to Telegram HTML.
 */
const TELEGRAM_MESSAGE_MAX_CHARACTERS = 4_096;
const TELEGRAM_LINK_MAX_CHARACTERS = 2_048;
const REPEATED_EMOJI_MINIMUM = 8;
const INLINE_PLACEHOLDER_START = 0xE000;
const INLINE_PLACEHOLDER_END = 0xF8FF;
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tg:"]);

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
