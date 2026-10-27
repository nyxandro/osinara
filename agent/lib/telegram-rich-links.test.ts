/**
 * Telegram web addresses in a rich message: no caption hides which bot or chat a link opens.
 *
 * Constructs covered:
 * - A `t.me`-style link behind a caption gets its address next to the caption, as a link of its own.
 * - The same in references, media and raw HTML, where escapes and entities may disguise the host.
 * - Host spellings a URL reader may take for another site: a trailing dot, a backslash before `@`.
 * - Links whose caption is the address, bare addresses and lookalike hosts stay as written.
 */
import type { Link } from "mdast";
import { describe, expect, it } from "vitest";

import { nodeRange, readMarkdownTree, walkMarkdownTree } from "./markdown-syntax.js";
import { sanitizeTelegramRichMarkdown } from "./telegram-rich-markdown.js";

// Independent of the filter's own reading: any authority ending in a Telegram domain.
const TELEGRAM_URL_PATTERN = /^https?:\/\/(?:[^/?#]*[@.\\])?(?:t\.me|telegram\.me|telegram\.dog)\.*(?:[:/?#]|$)/iu;

/** The links Telegram would render to its own domains, each with the caption it would show. */
function telegramLinks(markdown: string): Array<{ caption: string; url: string }> {
  const links: Array<{ caption: string; url: string }> = [];
  walkMarkdownTree(readMarkdownTree(markdown), (node) => {
    if (node.type !== "link" || node.position === undefined || !TELEGRAM_URL_PATTERN.test(node.url)) return;
    const children = (node as Link).children;
    const caption = children.length === 0
      ? ""
      : markdown.slice(nodeRange(children[0]!).start, nodeRange(children.at(-1)!).end);
    links.push({ caption, url: node.url });
  });
  return links;
}

/** Every Telegram link shows its own address, the way a bare `www.` address shows itself. */
function expectAddressesInSight(markdown: string): void {
  for (const link of telegramLinks(markdown)) {
    expect([link.url, link.url.replace(/^https?:\/\//iu, "")]).toContain(link.caption);
  }
}

describe("Telegram addresses in a rich message", () => {
  it.each([
    ["a bot with a start command", "[подробнее](https://t.me/evil_bot?start=x)", "https://t.me/evil_bot?start=x"],
    ["a channel subdomain", "[новости](https://news.t.me)", "https://news.t.me"],
    ["another Telegram domain", "[чат](http://telegram.me/x)", "http://telegram.me/x"],
    ["the third Telegram domain in capitals", "[бот](https://TELEGRAM.DOG/x)", "https://TELEGRAM.DOG/x"],
    ["a host with a trailing dot", "[бот](https://t.me./evil_bot)", "https://t.me./evil_bot"],
    ["media", "![фото](https://t.me/i/userpic/x.jpg)", "https://t.me/i/userpic/x.jpg"],
  ])("puts the address next to the caption of %s", (_case, markdown, address) => {
    const sanitized = sanitizeTelegramRichMarkdown(markdown);

    expect(sanitized).toContain(`([${address}](${address}))`);
    expectAddressesInSight(sanitized);
  });

  it("shows an address Markdown would read differently as text, next to the caption", () => {
    const sanitized = sanitizeTelegramRichMarkdown("[бот](https://good.com\\\\@t.me/evil_bot)");

    expect(sanitized).toBe("бот (https://good.com\\@t.me/evil_bot)");
    expectAddressesInSight(sanitized);
  });

  it("keeps the word a link was glued to out of the address", () => {
    const sanitized = sanitizeTelegramRichMarkdown("Подпишитесь на [наш канал](https://t.me/chan)ом.");

    expect(telegramLinks(sanitized)).toEqual([{ caption: "https://t.me/chan", url: "https://t.me/chan" }]);
    expect(sanitized).toContain(")ом.");
  });

  it.each([
    ["a plain reference", "Открой [канал][r].\n\n[r]: https://t.me/evil", "\\[r]: https://t.me/evil"],
    ["a reference with a trailing dot", "Открой [канал][r].\n\n[r]: https://t.me./evil", "\\[r]: https://t.me./evil"],
  ])("shows the address of %s as text", (_case, markdown, shown) => {
    const sanitized = sanitizeTelegramRichMarkdown(markdown);

    expect(sanitized).toContain(shown);
    expectAddressesInSight(sanitized);
  });

  it.each([
    ["a plain address", "[бот](https://t.me/evil_bot)", "бот (https://t.me/evil_bot)"],
    ["an escaped dot", "[бот](https://t\\.me/evil_bot?start=x)", "бот (https://t\\.me/evil_bot?start=x)"],
    ["an entity for the dot", "[бот](https://t&#46;me/evil_bot)", "бот (https://t&#46;me/evil_bot)"],
    ["a named entity for the dot", "[бот](https://t&period;me/evil_bot)", "бот (https://t&period;me/evil_bot)"],
    [
      "a caption Markdown reads from an inner bracket",
      "[https://t.me/evil_bot?start=[бот](https://t.me/evil_bot?start=[бот)",
      "https://t.me/evil_bot?start=[бот (https://t.me/evil_bot?start=[бот)",
    ],
  ])("shows the address in a collapsible block's summary: %s", (_case, link, shown) => {
    const sanitized = sanitizeTelegramRichMarkdown(`<details><summary>${link}</summary>\n\nТекст\n\n</details>`);

    expect(sanitized).toContain(`<summary>${shown}</summary>`);
  });

  it("shows the address in an HTML block opened by an allowed tag", () => {
    expect(sanitizeTelegramRichMarkdown("<u>\n[бот](https://t\\.me/evil_bot)\n</u>"))
      .toContain("бот (https://t\\.me/evil_bot)");
  });

  it.each([
    ["a link captioned with its own address", "[https://t.me/durov](https://t.me/durov) и [t.me/durov](https://t.me/durov)"],
    ["a bare address", "Канал: https://t.me/durov и www.t.me/durov"],
    ["a lookalike domain", "[сайт](https://t.me.example.com/x) и [сайт](https://notat.me/x)"],
    ["an ordinary site in a summary", "<details><summary>[сайт](https://example.com/a\\_b)</summary>\n\nТекст\n\n</details>"],
  ])("leaves %s as it is", (_case, markdown) => {
    expect(sanitizeTelegramRichMarkdown(markdown)).toBe(markdown);
  });
});
