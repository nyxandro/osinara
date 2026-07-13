/**
 * Telegram Markdown rendering and delivery regression tests.
 *
 * Coverage:
 * - Safe Telegram HTML conversion for common model-authored Markdown.
 * - Readable GFM tables and bounded pathological emoji repetition.
 * - Balanced chunks below Telegram's message limit.
 * - Balanced native draft previews below Telegram's text limit.
 * - Explicit HTML parse mode on every independently posted chunk.
 */
import { describe, expect, it, vi } from "vitest";

import {
  formatTelegramMarkdown,
  formatTelegramMarkdownDraft,
  postTelegramMarkdown,
} from "./telegram-markdown.js";

describe("formatTelegramMarkdown", () => {
  it("renders useful Markdown and escapes raw HTML", () => {
    const [html] = formatTelegramMarkdown([
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

  it("keeps every long formatted chunk balanced and within Telegram's limit", () => {
    const chunks = formatTelegramMarkdown(`**${"длинный текст ".repeat(700)}**`);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4_096);
      expect((chunk.match(/<b>/gu) ?? []).length).toBe((chunk.match(/<\/b>/gu) ?? []).length);
    }
    expect(chunks.join("").replaceAll("</b><b>", "")).toBe(
      `<b>${"длинный текст ".repeat(700)}</b>`,
    );
  });

  it("renders GFM tables as preformatted text and collapses repeated status emoji", () => {
    const [html] = formatTelegramMarkdown([
      "| Шаг | Статус |",
      "| --- | --- |",
      `| Открытие | ${"❌ ".repeat(80)}|`,
    ].join("\n"));

    expect(html).toContain("<pre>Шаг | Статус\nОткрытие | ❌ × 80</pre>");
    expect(html).not.toContain("---");
    expect(html).not.toContain("❌ ❌ ❌");
  });

  it("stops draft updates once the complete preview exceeds Telegram's native limit", () => {
    const preview = formatTelegramMarkdownDraft(`**${"длинный текст ".repeat(4_000)}**`);

    expect(preview).toBeNull();
  });

  it("renders an URL whose escaped tag would exceed the message limit as plain text", () => {
    const url = `https://example.com/?${"&".repeat(900)}`;
    const chunks = formatTelegramMarkdown(`[Ссылка](${url})`);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4_096)).toBe(true);
    expect(chunks.join("")).not.toContain("<a href=");
    expect(chunks.join("")).toContain("[Ссылка](https://example.com/?&amp;");
  });
});

describe("postTelegramMarkdown", () => {
  it("posts every pre-split chunk with Telegram HTML enabled", async () => {
    const post = vi.fn(async (_body: { parse_mode: "HTML"; text: string }) => ({
      id: "1",
      raw: null,
    }));

    await postTelegramMarkdown({ post }, `# Заголовок\n\n${"слово ".repeat(1_000)}`);

    expect(post.mock.calls.length).toBeGreaterThan(1);
    for (const [body] of post.mock.calls) {
      expect(body).toMatchObject({ parse_mode: "HTML" });
      expect(body.text.length).toBeLessThanOrEqual(4_096);
    }
  });
});
