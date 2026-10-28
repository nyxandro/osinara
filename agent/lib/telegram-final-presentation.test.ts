/**
 * Telegram final-presentation selection tests.
 *
 * Constructs covered:
 * - Conversational text stays on the plain Telegram transport.
 * - Supported formatting selects Rich Message delivery.
 * - Long output is collapsed even when the model omits the mandatory details block.
 * - Authored asides become paced messages unless the answer is collapsed as long.
 * - An answer with reply buttons ends in a rich message, its plain text stays literal, and its
 *   closing question stays outside the generated accordion.
 * - Formatting a rich message cannot hold goes out as written text instead of costing the answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatTelegramFinalPresentation } from "./telegram-final-presentation.js";
import { TELEGRAM_ASIDE_DIRECTIVE } from "./telegram-authored-split.js";

describe("Telegram final presentation", () => {
  it.each([
    "да не, ерунда, я пробовала",
    "можно попробовать\nно я бы не стала усложнять",
    "цена 2 * 3 доллара",
    "цена $5, скидка $2",
    "цена $5 + $2",
    "было $100 - $80",
  ])("keeps conversational text plain: %s", (text) => {
    expect(formatTelegramFinalPresentation(text))
      .toEqual([{ format: "plain", pacing: "immediate", text }]);
  });

  it.each([
    "**Да**, это важно",
    "## Итог\n\nГотово",
    "- первый вариант\n- второй вариант",
    "[Документация](https://example.com)",
    "«_важно_»",
    "<details><summary>Разбор</summary>\n\nТекст\n\n</details>",
  ])("selects Rich Message for supported formatting: %s", (markdown) => {
    expect(formatTelegramFinalPresentation(markdown)).toEqual([{
      format: "rich",
      pacing: "immediate",
      text: markdown,
    }]);
  });

  it("recognizes a GFM table without outer pipes and collapses it", () => {
    const markdown = "Параметр | Значение\n--- | ---\nрежим | plain";
    const output = formatTelegramFinalPresentation(markdown)[0]!;

    expect(output.format).toBe("rich");
    expect(output.text).toContain("<details><summary>Полный ответ</summary>");
    expect(output.text).toContain(markdown);
  });

  it.each([
    "а".repeat(601),
    Array.from({ length: 8 }, (_, index) => `строка ${index + 1}`).join("\n"),
    "первый абзац\n\nвторой абзац\n\nтретий абзац",
    Array.from({ length: 6 }, (_, index) => `- пункт ${index + 1}`).join("\n"),
  ])("collapses output after any long-answer threshold", (text) => {
    const chunks = formatTelegramFinalPresentation(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ format: "rich" });
    expect(chunks[0]!.text).toContain("<details><summary>Полный ответ</summary>");
    expect(chunks[0]!.text).toContain("</details>");
  });

  it("delivers an authored aside as its own paced message", () => {
    const markdown = `Счёт за август — 12 долларов\n${TELEGRAM_ASIDE_DIRECTIVE}\nа, и да — почти всё это один голосовой`;

    expect(formatTelegramFinalPresentation(markdown)).toEqual([
      { format: "plain", pacing: "immediate", text: "Счёт за август — 12 долларов" },
      { format: "plain", pacing: "aside", text: "а, и да — почти всё это один голосовой" },
    ]);
  });

  it("keeps aside pacing independent of the main answer transport", () => {
    const markdown = `**Итог:** счёт вырос втрое\n${TELEGRAM_ASIDE_DIRECTIVE}\nхотя это всё ещё меньше подписки`;
    const chunks = formatTelegramFinalPresentation(markdown);

    expect(chunks).toEqual([
      { format: "rich", pacing: "immediate", text: "**Итог:** счёт вырос втрое" },
      { format: "plain", pacing: "aside", text: "хотя это всё ещё меньше подписки" },
    ]);
  });

  it("collapses a long main answer without swallowing the aside", () => {
    const markdown = `${"подробность ".repeat(70)}\n${TELEGRAM_ASIDE_DIRECTIVE}\nвот такой расклад`;
    const chunks = formatTelegramFinalPresentation(markdown);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ format: "rich", pacing: "immediate" });
    expect(chunks[0]!.text).toContain("<details><summary>Полный ответ</summary>");
    expect(chunks[1]).toEqual({ format: "plain", pacing: "aside", text: "вот такой расклад" });
  });

  it("keeps a structured aside as its own message", () => {
    const markdown = `Что делать\n${TELEGRAM_ASIDE_DIRECTIVE}\n- сначала одно\n- потом другое`;

    expect(formatTelegramFinalPresentation(markdown)).toEqual([
      { format: "plain", pacing: "immediate", text: "Что делать" },
      { format: "rich", pacing: "aside", text: "- сначала одно\n- потом другое" },
    ]);
  });

  it("keeps a short direct lead outside the generated accordion", () => {
    const body = "подробность ".repeat(70);

    expect(formatTelegramFinalPresentation(`короткий вывод\n\n${body}`)[0]!.text).toBe(
      `короткий вывод\n\n<details><summary>Полный ответ</summary>\n\n${body.trim()}\n\n</details>`,
    );
  });

  it("preserves an authored details block without wrapping it again", () => {
    const markdown = `<details><summary>Разбор</summary>\n\n${"текст ".repeat(150)}\n\n</details>`;

    expect(formatTelegramFinalPresentation(markdown))
      .toEqual([{ format: "rich", pacing: "immediate", text: markdown }]);
  });

  it("recognizes an indented valid details block", () => {
    const markdown = `  <details open><summary>Разбор</summary>\n\n${"текст ".repeat(150)}\n\n  </details>`;

    const output = formatTelegramFinalPresentation(markdown)[0]!.text;
    expect(output.match(/<details/gu)).toHaveLength(1);
    expect(output).toContain("<details open><summary>Разбор</summary>");
  });

  it("wraps a long block whose details tag has forbidden attributes", () => {
    const markdown = `<details class="wide"><summary>Разбор</summary>\n\n${"текст ".repeat(150)}\n\n</details>`;

    const output = formatTelegramFinalPresentation(markdown)[0]!.text;
    expect(output).toContain("<details><summary>Полный ответ</summary>");
    expect(output).toContain("&lt;details class=\"wide\"&gt;");
  });

  it.each([
    `<details>\n\n${"текст ".repeat(150)}\n\n</details>`,
    `<details><summary>Разбор\n\n${"текст ".repeat(150)}`,
  ])("wraps malformed authored details instead of trusting it: %s", (markdown) => {
    const output = formatTelegramFinalPresentation(markdown)[0]!.text;

    expect(output).toContain("<details><summary>Полный ответ</summary>");
    expect(output).toContain("&lt;details&gt;");
  });

  it("keeps a short rich warning outside the generated accordion", () => {
    const body = "подробность ".repeat(70);

    expect(formatTelegramFinalPresentation(`**Риск высокий.**\n\n${body}`)[0]!.text).toBe(
      `**Риск высокий.**\n\n<details><summary>Полный ответ</summary>\n\n${body.trim()}\n\n</details>`,
    );
  });

  describe("past the limits of a rich message", () => {
    const wideTable = [
      `| ${Array.from({ length: 25 }, (_, index) => `д${index + 1}`).join(" | ")} |`,
      `| ${Array.from({ length: 25 }, () => "---").join(" | ")} |`,
      `| ${Array.from({ length: 25 }, () => "x").join(" | ")} |`,
    ].join("\n");
    // An authored accordion keeps the answer from being folded, so the long block stays whole.
    const oversizedBlock = "<details><summary>Итог</summary>\n\nКоротко.\n\n</details>\n\n" +
      `**Важно:** ${"я".repeat(33_000)}`;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([
      ["a table wider than Telegram allows", wideTable, "AGENT_TELEGRAM_RICH_TABLE_TOO_WIDE"],
      ["an indivisible block over the size limit", oversizedBlock, "AGENT_TELEGRAM_RICH_BLOCK_TOO_LONG"],
      [
        "nesting deeper than Telegram allows",
        `${"<details><summary>У</summary>\n\n".repeat(17)}текст${"\n\n</details>".repeat(17)}`,
        "AGENT_TELEGRAM_RICH_NESTING_TOO_DEEP",
      ],
    ])("sends %s as written text", (_name, markdown, reason) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const chunks = formatTelegramFinalPresentation(markdown);

      expect(chunks.every((chunk) => chunk.format === "plain")).toBe(true);
      expect(chunks.every((chunk) => chunk.text.length <= 4_096)).toBe(true);
      expect(chunks.map((chunk) => chunk.text).join("").replace(/\s/gu, ""))
        .toBe(markdown.replace(/\s/gu, ""));
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0]![0] as string))
        .toEqual({ code: "AGENT_TELEGRAM_RICH_FORMAT_DEGRADED", reason });
    });

    it("keeps such an answer literal in the rich message that carries reply buttons", () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      expect(formatTelegramFinalPresentation(wideTable, { replyButtons: true })).toEqual([{
        format: "rich",
        pacing: "immediate",
        text: `<p>${wideTable.split("\n").join("<br>")}</p>`,
      }]);
    });

    it("filters links there like in a rich message", () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const markdown = `Посмотрите [подробнее](https://t.me/some_bot?start=x)\n\n${wideTable}`;
      const [chunk] = formatTelegramFinalPresentation(markdown, { replyButtons: true });

      expect(chunk!.format).toBe("rich");
      expect(chunk!.text).not.toContain("[подробнее](");
      expect(chunk!.text).toContain("подробнее (");
    });

    it("still fails on a formatting error that is not a rich limit", () => {
      let privateUseCharacters = "";
      for (let codePoint = 0xE000; codePoint <= 0xF8FF; codePoint += 1) {
        privateUseCharacters += String.fromCodePoint(codePoint);
      }

      expect(() => formatTelegramFinalPresentation(`**Да**, ${privateUseCharacters}`))
        .toThrowError("AGENT_TELEGRAM_RICH_PLACEHOLDER_UNAVAILABLE");
    });

    it("degrades only the authored message that cannot be formatted", () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      expect(formatTelegramFinalPresentation(`**Готово**\n${TELEGRAM_ASIDE_DIRECTIVE}\n${wideTable}`)).toEqual([
        { format: "rich", pacing: "immediate", text: "**Готово**" },
        { format: "plain", pacing: "aside", text: wideTable },
      ]);
    });
  });

  describe("with reply buttons", () => {
    it("sends even a plain answer as a rich message, since only one carries buttons", () => {
      expect(formatTelegramFinalPresentation("Заказываем?", { replyButtons: true }))
        .toEqual([{ format: "rich", pacing: "immediate", text: "<p>Заказываем?</p>" }]);
    });

    it("keeps plain text literal there: prices, signs and every line break", () => {
      const text = "Нашёл два варианта:\nПицца — 650 ₽, $5\n# Суши <лучше> & дешевле\n\nЧто берём?";

      expect(formatTelegramFinalPresentation(text, { replyButtons: true })[0]!.text).toBe(
        "<p>Нашёл два варианта:<br>Пицца — 650 ₽, $5<br># Суши &lt;лучше&gt; &amp; дешевле</p>\n\n<p>Что берём?</p>",
      );
    });

    it("keeps the closing question of a long answer outside the accordion", () => {
      const body = "подробность ".repeat(70).trim();
      const chunks = formatTelegramFinalPresentation(`короткий вывод\n\n${body}\n\nЗаказываем?`, { replyButtons: true });

      expect(chunks).toEqual([{
        format: "rich",
        pacing: "immediate",
        text: `короткий вывод\n\n<details><summary>Полный ответ</summary>\n\n${body}\n\n</details>\n\nЗаказываем?`,
      }]);
    });

    it("closes a code block a long answer left open before folding it", () => {
      const markdown = `короткий вывод\n\n${"подробность ".repeat(70).trim()}\n\n\`\`\`js\nconst a = 1;`;
      const [chunk] = formatTelegramFinalPresentation(markdown);

      expect(chunk!.text.endsWith("```js\nconst a = 1;\n```\n\n</details>")).toBe(true);
    });

    it("makes only the last message rich when the answer has an aside", () => {
      expect(formatTelegramFinalPresentation(`Готово\n${TELEGRAM_ASIDE_DIRECTIVE}\nПовторить заказ?`, { replyButtons: true }))
        .toEqual([
          { format: "plain", pacing: "immediate", text: "Готово" },
          { format: "rich", pacing: "aside", text: "<p>Повторить заказ?</p>" },
        ]);
    });
  });
});
