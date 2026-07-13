/**
 * Telegram caption Markdown rendering regression tests.
 *
 * Coverage:
 * - Safe Telegram HTML conversion for model-authored file captions.
 * - Readable tables and bounded pathological emoji repetition.
 */
import { describe, expect, it } from "vitest";

import { renderTelegramMarkdownHtml } from "./telegram-markdown.js";

describe("renderTelegramMarkdownHtml", () => {
  it("renders useful Markdown and escapes raw HTML", () => {
    const html = renderTelegramMarkdownHtml([
      "# Результат",
      "",
      "**Важно:** *текст* и `код`.",
      "",
      "> Цитата",
      "",
      "[Сайт](https://example.com?a=1&b=2) <script>alert(1)</script>",
      "",
      "```ts",
      "const value = 1 < 2;",
      "```",
    ].join("\n"));

    expect(html).toContain("<b>Результат</b>");
    expect(html).toContain("<b>Важно:</b> <i>текст</i> и <code>код</code>.");
    expect(html).toContain("<blockquote>Цитата</blockquote>");
    expect(html).toContain('<a href="https://example.com?a=1&amp;b=2">Сайт</a>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<pre><code>const value = 1 &lt; 2;</code></pre>");
  });

  it("renders GFM tables as preformatted text and collapses repeated status emoji", () => {
    const html = renderTelegramMarkdownHtml([
      "| Шаг | Статус |",
      "| --- | --- |",
      `| Открытие | ${"❌ ".repeat(80)}|`,
    ].join("\n"));

    expect(html).toContain("<pre>Шаг | Статус\nОткрытие | ❌ × 80</pre>");
    expect(html).not.toContain("---");
    expect(html).not.toContain("❌ ❌ ❌");
  });

});
