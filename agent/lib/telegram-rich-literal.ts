/**
 * Plain text carried literally inside a Telegram rich message.
 *
 * Export:
 * - `literalRichParagraphs`: HTML paragraphs that keep every character and line break as written.
 *
 * Rich markdown reads a single line break as a space and many characters as markup: `$…$` as a
 * formula, `#` as a heading, `1)` as a list. Inside an HTML paragraph only `&`, `<` and `>` mean
 * anything, so they are escaped, a blank line starts a new paragraph and a line break becomes
 * `<br>`. The paragraphs are complete HTML blocks: the caller sends them as they are, never through
 * the markdown sanitizer, which would show the tags as text.
 */
export function literalRichParagraphs(text: string): string {
  return text.trim().split(/\r?\n[ \t]*(?:\r?\n[ \t]*)+/u).map((paragraph) => {
    const escaped = paragraph.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return `<p>${escaped.split(/\r?\n/u).join("<br>")}</p>`;
  }).join("\n\n");
}
