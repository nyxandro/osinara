/**
 * Safe Telegram Rich Markdown regression tests.
 *
 * Constructs covered:
 * - Supported text-rich Markdown and a narrow inline HTML allowlist survive sanitization.
 * - Tolerated spellings of the collapsible block are canonicalized instead of escaped.
 * - A truncated collapsible block is closed; other malformed allowed HTML is rendered inert.
 * - Model-authored media, Telegram service tags, and unsafe links are rendered inert.
 * - Final rich messages split only between complete blocks at Telegram's length limit.
 */
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { markdownCodeRanges, readMarkdownTree, trustedCodeRanges, walkMarkdownTree } from "./markdown-syntax.js";

import {
  formatTelegramRichMessages,
  sanitizeTelegramRichMarkdown,
} from "./telegram-rich-markdown.js";

describe("sanitizeTelegramRichMarkdown", () => {
  it("keeps useful rich structure and only explicitly allowed HTML", () => {
    const markdown = [
      "## Сравнение",
      "",
      "| Вариант | Риск |",
      "| --- | --- |",
      "| A | Низкий |",
      "",
      "<details open><summary>Обоснование</summary>",
      "",
      "Формула $x^2$ и <u>важный текст</u>.",
      "",
      "</details>",
    ].join("\n");

    expect(sanitizeTelegramRichMarkdown(markdown)).toBe(markdown);
  });

  it("neutralizes raw media, service tags, scripts, and unsafe inline links", () => {
    const sanitized = sanitizeTelegramRichMarkdown([
      "![чужое изображение](https://tracker.example/image.png)",
      '<img src="https://tracker.example/image.png"/>',
      "<tg-thinking>Подмена</tg-thinking>",
      "<script>alert(1)</script>",
      "[опасная ссылка](javascript:alert(1))",
    ].join("\n"));

    expect(sanitized).toContain("\\![чужое изображение]");
    expect(sanitized).toContain("&lt;img src=");
    expect(sanitized).toContain("&lt;tg-thinking>");
    expect(sanitized).toContain("&lt;script>");
    expect(sanitized).toContain("опасная ссылка (javascript:alert(1))");
    expect(sanitized).not.toContain('<img src="');
    expect(sanitized).not.toContain("<tg-thinking>");
  });

  it("neutralizes unsafe links with nested parentheses", () => {
    const sanitized = sanitizeTelegramRichMarkdown([
      "[javascript](javascript:alert((1)))",
      "[telegram](tg://resolve?domain=a(b(c)))",
      "[safe](https://example.com/a(b(c)))",
    ].join("\n"));

    expect(sanitized).toContain("javascript (javascript:alert((1)))");
    expect(sanitized).toContain("telegram (tg://resolve?domain=a(b(c)))");
    expect(sanitized).toContain("[safe](https://example.com/a(b(c)))");
    expect(sanitized).not.toContain("[javascript](javascript:");
    expect(sanitized).not.toContain("[telegram](tg:");
  });

  it("ignores allowed-looking HTML inside inline and fenced code", () => {
    const markdown = [
      "`<details>` остаётся примером.",
      "",
      "```html",
      "<details><summary>Пример</summary>",
      "```",
    ].join("\n");

    expect(sanitizeTelegramRichMarkdown(markdown)).toBe(markdown);
  });

  it.each([
    ["an indented line after a paragraph", "Смотрите:\n    <tg-button type=\"web_app\" url=\"https://evil.example\">Открыть</tg-button>"],
    ["an escaped backtick", "Смотрите: \\`<tg-button type=\"url\" url=\"tg://resolve?domain=x\">Открыть</tg-button>\\`"],
    ["an unclosed fence", "Смотрите:\n```\n<tg-button-row><tg-button type=\"copy_text\" text=\"x\">Копировать</tg-button></tg-button-row>"],
  ])("never lets a Telegram tag through %s, where it would be live", (_case, markdown) => {
    const sanitized = sanitizeTelegramRichMarkdown(markdown);

    expect(sanitized).not.toMatch(/<\/?tg-/u);
    // The reader still sees the same characters: the break is an invisible zero-width space.
    expect(sanitized.replaceAll("\u200B", "")).toContain("tg-button");
  });

  it.each([
    ["an indented fence after a paragraph", "**Смотрите:**\n    ```\n    <a href=\"tg://resolve?domain=evil&start=x\">профиль</a> <img src=\"https://evil.example/p.png\"/>"],
    ["an escaped backtick", "Смотрите: \\`<a href=\"tg://resolve?domain=evil\">профиль</a>\\`"],
    ["a fence opened in the middle of a line", "Смотрите ```<img src=\"https://evil.example/p.png\"/>"],
    ["a code span broken across lines", "Смотри `начало\nконец` <img src=\"https://evil.example/p.png\"> `хвост`"],
    ["a backtick inside a link address", "[a](https://ok.example/`) <img src=\"https://evil.example/p.png\"> `"],
    ["an unclosed fence closed by the next list item", "1. Шаг\n   ```\n   npm i\n2. <img src=\"https://evil.example/p.png\">"],
    ["a code span a bare address runs into once `<` is escaped", "<img src=\"https://evil.example/p.png\">`<a href=\"tg://x\">профиль</a>`"],
  ])("treats as code only what Telegram shows as code, so HTML behind %s stays inert", (_case, markdown) => {
    const sanitized = sanitizeTelegramRichMarkdown(markdown);

    expect(sanitized).not.toMatch(/<a\s|<img/u);
    expect(sanitized).toContain("&lt;");
  });

  it.each([
    ["a title", "[профиль](tg://resolve?domain=evil \"t\")"],
    ["a space before the address", "[профиль]( tg://resolve?domain=evil)"],
    ["an escaped scheme", "[профиль](tg&#58;//resolve?domain=evil)"],
    ["the next list item after an unclosed fence", "1. Шаг\n   ```\n   npm i\n2. [профиль](tg://resolve?domain=evil)"],
  ])("opens no unsafe link written with %s", (_case, markdown) => {
    const sanitized = sanitizeTelegramRichMarkdown(markdown);

    expect(sanitized).toContain("профиль (tg://resolve?domain=evil)");
    expect(sanitized).not.toMatch(/\]\(\s*tg/u);
  });

  it.each([
    ["before the summary", "<details>\n[r]: tg://evil\n<summary>Итог</summary>\n\n[профиль][r]\n\n</details>"],
    ["without a summary", "<details>\n[r]:\ntg://evil\nтекст\n</details>\n\n[профиль][r]"],
    ["with a label across lines", "<details><summary>Итог</summary>[r\nr]: tg://evil</details>\n\n[профиль][r\nr]"],
  ])("breaks a link definition inside a collapsible block %s", (_case, markdown) => {
    expect(sanitizeTelegramRichMarkdown(markdown)).not.toMatch(/(?<!\\)\[r(?:\nr)?\]:/u);
  });

  it("does not trust a fenced block that starts inside a multi-line formula", () => {
    const sanitized = sanitizeTelegramRichMarkdown("$$\n```\n$$\n<img src=\"https://evil.example/p.png\">\n```");
    expect(sanitized).not.toContain("<img");
  });

  it("escapes HTML in indented code instead of treating allowed tags there as markup", () => {
    const markdown = "Пример:\n\n    <details><summary>Итог</summary>\n    текст\n    </details>\n\nДальше";
    const sanitized = sanitizeTelegramRichMarkdown(markdown);

    expect(sanitized).not.toMatch(/<\/?(?:details|summary)/u);
    expect(sanitized.split("\n").length).toBe(markdown.split("\n").length);
  });

  it("trusts a code span when a dollar sign comes only after it", () => {
    expect(sanitizeTelegramRichMarkdown("Команда `grep <file` стоит $5")).toBe("Команда `grep <file` стоит $5");
    expect(sanitizeTelegramRichMarkdown("Цена $5, команда `grep <file`")).toContain("&lt;file");
  });

  it("counts a long tilde code block as one block, not one per line", () => {
    const markdown = `~~~text\n${Array.from({ length: 900 }, (_, index) => `line ${index}`).join("\n")}\n~~~`;
    expect(formatTelegramRichMessages(markdown)).toEqual([markdown]);
  });

  it.each(["```", "~~~"])("splits a code block longer than a message into parts that each reopen %s", (fence) => {
    const lines = Array.from({ length: 900 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
    const chunks = formatTelegramRichMessages(`${fence}text\n${lines}\n${fence}`);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith(`${fence}text\n`) && chunk.endsWith(`\n${fence}`))).toBe(true);
  });

  it("opens no link written in indented code, which Telegram may show as text", () => {
    const sanitized = sanitizeTelegramRichMarkdown("    [профиль](tg://resolve?domain=evil)\n    [r]: tg://evil");

    // Read as text, as Telegram might: every bracket that could open a link is escaped.
    const asText = readMarkdownTree(sanitized.replace(/^ {4}/gmu, ""));
    walkMarkdownTree(asText, (node) => expect(["definition", "link"]).not.toContain(node.type));
  });

  it("turns a reference to an unsafe definition into plain text", () => {
    const sanitized = sanitizeTelegramRichMarkdown("Открой [профиль][r].\n\n[r]: tg://resolve?domain=evil");

    expect(sanitized).toContain("\\[r]: tg://resolve?domain=evil");
  });

  it("leaves an autolink to a Telegram address dead and a safe one alone", () => {
    const sanitized = sanitizeTelegramRichMarkdown("<tg://resolve?domain=evil> и [сайт](https://example.com) и www.example.com");

    expect(sanitized).toContain("&lt;tg://resolve?domain=evil>");
    expect(sanitized).toContain("[сайт](https://example.com) и www.example.com");
  });

  it("reads the inside of a collapsible block as Markdown, so no link there opens", () => {
    const sanitized = sanitizeTelegramRichMarkdown([
      "<details><summary>Итог</summary>[раз](tg://one)",
      "[два",
      "строкой](tg://two) и [три](",
      "tg://three) и [четыре][r]",
      "",
      "[r]: tg://four",
      "</details>",
    ].join("\n"));

    expect(sanitized.startsWith("<details><summary>Итог</summary>\n\n")).toBe(true);
    expect(sanitized.endsWith("\n\n</details>")).toBe(true);
    expect(sanitized).not.toMatch(/\]\(\s*tg:/u);
    expect(sanitized).toContain("\\[r]: tg://four");
  });

  it("keeps a link Telegram may read inside a collapsible block's summary from opening", () => {
    const sanitized = sanitizeTelegramRichMarkdown("<details><summary>[профиль](tg://resolve?domain=evil)</summary>\n\nТекст\n\n</details>");

    expect(sanitized).toContain("<summary>профиль (tg://resolve?domain=evil)</summary>");
    expect(sanitizeTelegramRichMarkdown("<details><summary>[проф\nиль](\ntg://evil \n\"t\")</summary>\n\nТекст\n\n</details>"))
      .toContain("<summary>проф\nиль (tg://evil \n\"t\")</summary>");
  });

  it.each([
    ["a bash fence", "```bash\nIFS=$'\\n'\necho $$ $& $` $'\n```\nдальше"],
    ["inline code", "Запусти `echo $$` и `IFS=$'\\n'`, а `'[$&]'` оставь"],
  ])("keeps the dollar signs of %s exactly as written", (_case, markdown) => {
    expect(sanitizeTelegramRichMarkdown(markdown)).toBe(markdown);
  });

  it("keeps many dollar-quoted code spans without blowing up", () => {
    const markdown = Array.from({ length: 12 }, () => "`IFS=$'\\n'`").join(" ");
    expect(sanitizeTelegramRichMarkdown(markdown)).toBe(markdown);
  });

  it.each([
    ["a list item", "1. Шаг:\n   ```bash\n   npm i", "1. Шаг:\n   ```bash\n   npm i\n   ```"],
    ["a quotation", "> ```\n> код", "> ```\n> код\n> ```"],
    ["the line of a bullet", "- ```js\n  const a = 1;", "- ```js\n  const a = 1;\n  ```"],
    ["the line of a numbered item", "1. ```bash\n   npm i", "1. ```bash\n   npm i\n   ```"],
  ])("closes a code block left open in %s where it stands", (_case, markdown, closed) => {
    expect(sanitizeTelegramRichMarkdown(markdown)).toBe(closed);
  });

  it("closes a code block a truncated answer left open inside a collapsible block", () => {
    expect(formatTelegramRichMessages("<details><summary>Код</summary>\n\n```js\nconst a = 1;"))
      .toEqual(["<details><summary>Код</summary>\n\n```js\nconst a = 1;\n```\n\n</details>"]);
  });

  it.each([
    ["nested images", `${"![".repeat(12)}x${"](https://ok.example/p.png)".repeat(12)}`],
    ["repeated tags with a backtick in an attribute", "<b title=\"`\">x".repeat(20)],
  ])("still sends an inert answer for %s instead of refusing it", (_case, markdown) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sanitized = sanitizeTelegramRichMarkdown(markdown);
    const tree = readMarkdownTree(sanitized);

    walkMarkdownTree(tree, (node) => expect(["image", "html"]).not.toContain(node.type));
    vi.restoreAllMocks();
  });

  it("keeps media inert behind an escaped backslash inside a collapsible block's summary", () => {
    const sanitized = sanitizeTelegramRichMarkdown("<details><summary>\\\\![x](https://evil.example/p.png)</summary>\n\nТекст\n\n</details>");
    expect(sanitized).toContain("<summary>\\\\\\![x](https://evil.example/p.png)</summary>");
  });

  it("keeps quotations as quotations", () => {
    expect(sanitizeTelegramRichMarkdown("> цитата\n> вторая строка\n\nа > б")).toBe("> цитата\n> вторая строка\n\nа > б");
  });

  it("keeps a fence indented inside a numbered item as code", () => {
    const markdown = "10. Шаг:\n    ```bash\n    echo hi > file && a => b <x>\n    ```";
    expect(sanitizeTelegramRichMarkdown(markdown)).toBe(markdown);
  });

  it("keeps a fence inside a list item as code and closes an unclosed fence at the end", () => {
    const markdown = "1. Пример:\n   ```html\n   <b>как есть</b>\n   ```\n\nЕщё:\n```\n<i>оборвано";

    expect(sanitizeTelegramRichMarkdown(markdown)).toBe(`${markdown}\n\`\`\``);
  });

  it("rejects tables wider than Telegram Rich Message supports", () => {
    const row = `| ${Array.from({ length: 21 }, (_, index) => `C${index}`).join(" | ")} |`;

    expect(() => sanitizeTelegramRichMarkdown(row)).toThrow(
      "AGENT_TELEGRAM_RICH_TABLE_TOO_WIDE",
    );
  });

  it("rejects an outerless GFM table wider than Telegram Rich Message supports", () => {
    const columns = Array.from({ length: 21 }, (_, index) => `C${index + 1}`);
    const delimiters = columns.map(() => "---");

    expect(() => sanitizeTelegramRichMarkdown(
      `${columns.join(" | ")}\n${delimiters.join(" | ")}\n${columns.join(" | ")}`,
    )).toThrowError("AGENT_TELEGRAM_RICH_TABLE_TOO_WIDE");
  });

  it("canonicalizes tolerated spellings of the collapsible block", () => {
    const sanitized = sanitizeTelegramRichMarkdown(
      ['<details open="true"><summary >Итог</summary>', "", "Текст", "", "</DETAILS>"].join("\n"),
    );

    expect(sanitized).toBe(
      ["<details open><summary>Итог</summary>", "", "Текст", "", "</details>"].join("\n"),
    );
  });

  it("renders a collapsible block with an unsupported attribute inert", () => {
    const sanitized = sanitizeTelegramRichMarkdown(
      '<details class="wide"><summary>Итог</summary>Текст</details>',
    );

    expect(sanitized).toContain('&lt;details class="wide">');
    expect(sanitized).toContain("&lt;/details>");
  });

  it("closes a truncated collapsible block instead of escaping the whole answer", () => {
    expect(
      formatTelegramRichMessages(
        "<details><summary>Результат</summary>\n\nОтвет без закрывающего details",
      ),
    ).toEqual([
      "<details><summary>Результат</summary>\n\nОтвет без закрывающего details\n\n</details>",
    ]);
  });

  it("neutralizes other unclosed allowed HTML instead of blocking final delivery", () => {
    expect(
      formatTelegramRichMessages("<details><summary>Результат\n\nОтвет без закрытия summary"),
    ).toEqual([
      "&lt;details>&lt;summary>Результат\n\nОтвет без закрытия summary",
    ]);
  });
});

describe("formatTelegramRichMessages", () => {
  it("splits oversized output only between complete Markdown blocks", () => {
    const paragraph = "слово ".repeat(3_000).trim();
    const chunks = formatTelegramRichMessages(`${paragraph}\n\n${paragraph}`);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 32_768)).toBe(true);
    expect(chunks).toEqual([paragraph, paragraph]);
  });

  it("does not split a fenced code block at its internal blank lines", () => {
    const paragraph = "я".repeat(30_000);
    const code = `\`\`\`text\n${"a".repeat(2_000)}\n\n${"b".repeat(2_000)}\n\`\`\``;
    const chunks = formatTelegramRichMessages(`${paragraph}\n\n${code}`);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(paragraph);
    expect(chunks[1]).toBe(code);
  });

  it("fails explicitly when one indivisible block exceeds the rich limit", () => {
    expect(() => formatTelegramRichMessages("я".repeat(32_769))).toThrow(
      "AGENT_TELEGRAM_RICH_BLOCK_TOO_LONG",
    );
  });

  it("splits an oversized details block into independently balanced messages", () => {
    const tail = "КОНЕЦ_ДЛИННОГО_ОТВЕТА";
    const body = `${"Большой раздел данных. ".repeat(3_500)}${tail}`;
    const chunks = formatTelegramRichMessages(
      `<details><summary>Подробный разбор</summary>\n\n${body}\n\n</details>`,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 32_768)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("<details><summary>"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("</details>"))).toBe(true);
    expect(chunks.at(-1)).toContain(tail);
  });

  it("splits an oversized details block whose body starts right after the summary line", () => {
    const lines = Array.from({ length: 600 }, (_, index) => `Строка ${index + 1} ${"данные ".repeat(10)}`);
    const chunks = formatTelegramRichMessages(`<details><summary>Лог</summary>\n${lines.join("\n")}\n</details>`);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith("<details><summary>Лог</summary>"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("</details>"))).toBe(true);
  });

  it("keeps the line breaks of a real answer in the message", () => {
    expect(formatTelegramRichMessages("**Итог:**\nМолоко — 100 ₽\nХлеб — 50 ₽\n\n- первый\n- второй"))
      .toEqual(["**Итог:**  \nМолоко — 100 ₽  \nХлеб — 50 ₽\n\n- первый\n- второй"]);
  });

  it.each([
    ["a tilde fence", "~~~", "~~~"],
    ["a four-backtick fence holding a three-backtick line", "````", "````"],
  ])("never splits %s at a blank line inside it, nor revives HTML it held", (_case, open, close) => {
    const body = Array.from({ length: 300 }, (_, index) => `строка ${index} ${"данные ".repeat(20)}`).join("\n\n");
    const code = `${open}\nначало\n\n\`\`\`\n\n<img src="https://evil.example/p.png">\n\n${close}`;
    const chunks = formatTelegramRichMessages(`${body}\n\n${code}\n\n${body}`);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const tree = readMarkdownTree(chunk);
      const code = markdownCodeRanges(tree);
      for (const tag of chunk.matchAll(/<img/gu)) {
        expect(code.some((range) => tag.index >= range.start && tag.index < range.end)).toBe(true);
      }
    }
    expect(chunks.some((chunk) => chunk.includes(code))).toBe(true);
  });

  it("keeps every rich chunk below the provider block-count limit", () => {
    const body = Array.from({ length: 501 }, (_, index) => `- пункт ${index + 1}`).join("\n");
    const chunks = formatTelegramRichMessages(
      `<details><summary>Большой список</summary>\n\n${body}\n\n</details>`,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith("<details><summary>"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("</details>"))).toBe(true);
    expect(chunks.every((chunk) => (chunk.match(/^- /gmu)?.length ?? 0) <= 498)).toBe(true);
  });
});

// What a model can write, or copy from a page that asks it to: links, media, HTML and every
// syntax that decides where code begins and ends.
const RISKY_PIECE = fc.constantFrom(
  "[", "]", "](", ")", "(", "tg://resolve?domain=evil", "https://ok.example", "javascript:alert(1)", "!",
  "<img src=\"https://evil.example/p.png\">", "<a href=\"tg://x\">", "</a>", "<details>", "</details>",
  "<summary>", "</summary>", "<u>", "</u>", "<tg-button>", "<tg://x>", "`", "```", "\\", " \"t\"", "[r]: ",
  "\n", "\n\n", "    ", "1. ", "- ", "> ", "текст", " ", "$", "$$", "~~~", "````", "IFS=$'\\n'",
  "<details><summary>Итог</summary>", "[подпись\n", "](\n", "|", "| a | b |\n|---|---|\n",
);
const SAFE_ADDRESS = /^(?:https?:|mailto:|tel:|#)/u;
const ALLOWED_TAG = /^<\/?(?:details|summary|u|ins|sub|sup)(?: open)?>/u;

/** No live unsafe link, no media and no unknown tag outside code Telegram is sure to show as code. */
function expectInert(sanitized: string): void {
  const tree = readMarkdownTree(sanitized);
  walkMarkdownTree(tree, (node) => {
    expect(node.type).not.toBe("image");
    if ((node.type === "link" || node.type === "definition") && !SAFE_ADDRESS.test(node.url)) {
      throw new Error(`live unsafe ${node.type}: ${node.url} in ${JSON.stringify(sanitized)}`);
    }
  });
  // Markdown opens a tag only with `<` and a letter, `/`, `!` or `?`; anything else is text.
  const code = trustedCodeRanges(sanitized, tree);
  for (const tag of sanitized.matchAll(/<(?=[A-Za-z/!?])/gu)) {
    if (code.some((range) => tag.index >= range.start && tag.index < range.end)) continue;
    expect(ALLOWED_TAG.test(sanitized.slice(tag.index)), JSON.stringify(sanitized)).toBe(true);
  }
}

describe("sanitizer property", () => {
  it("leaves no live unsafe link, no media and no unknown tag outside code, in every message", () => {
    fc.assert(fc.property(fc.array(RISKY_PIECE, { maxLength: 40 }), (pieces) => {
      let messages: string[];
      try {
        messages = formatTelegramRichMessages(pieces.join(""));
      } catch (error) {
        // Refusing is allowed, but only with the project's own error.
        expect(error).toMatchObject({ code: expect.stringMatching(/^AGENT_TELEGRAM_RICH_/u) });
        return;
      }
      for (const message of messages) expectInert(message);
    }), {
      examples: [
        [["[профиль](", "tg://resolve?domain=evil", " \"t\"", ")"]],
        [["`", "текст", "\n", "текст", "`", " ", "<img src=\"https://evil.example/p.png\">", " ", "`"]],
        [["1. ", "текст", "\n", "    ", "```", "\n", "2. ", "[", "x", "](", "tg://resolve?domain=evil", ")"]],
        [["1. ", "[r]: ", "<details><summary>Итог</summary>", "```"]],
      ],
    });
  });
});
