/**
 * Files the model places in its answer: where they are and where they go.
 *
 * Constructs covered:
 * - A `![caption](/workspace/<scope>/<path>)` outside code is a file of that scope, its caption the
 *   title when given, else the bracket text; encoded and bracketed paths read as the model wrote them.
 * - Web media, other addresses and workspace paths Markdown did not read as media are reported apart.
 * - Telegram takes media only as a block of its own: a file standing alone stays in place, any other
 *   leaves its block and follows it, in the order the model wrote them.
 */
import { describe, expect, it } from "vitest";

import { layOutAnswerFiles, readAnswerMedia } from "./answer-file-references.js";

function laidOut(markdown: string): string {
  const { files } = readAnswerMedia(markdown);
  return layOutAnswerFiles(markdown, files, (_file, index) => `TOKEN${index}`);
}

describe("files in a model answer", () => {
  it("reads a workspace file with its scope, path and caption", () => {
    const reading = readAnswerMedia("Вот рецепт.\n\n![Обложка](/workspace/personal/recipes/duchesse.jpg)");

    expect(reading.files).toEqual([
      expect.objectContaining({ caption: "Обложка", path: "recipes/duchesse.jpg", scope: "personal" }),
    ]);
    expect(reading.foreign).toEqual([]);
    expect(reading.unread).toBe(0);
  });

  it("takes the title as the caption and reads encoded and bracketed paths as written", () => {
    const reading = readAnswerMedia([
      "![alt](/workspace/family/a.png \"Подпись под фото\")",
      "",
      "![](/workspace/personal/рецепты/фото.jpg)",
      "",
      "![Отчёт](</workspace/group/My Report.pdf>)",
    ].join("\n"));

    expect(reading.files.map(({ caption, path, scope }) => ({ caption, path, scope }))).toEqual([
      { caption: "Подпись под фото", path: "a.png", scope: "family" },
      { caption: "", path: "рецепты/фото.jpg", scope: "personal" },
      { caption: "Отчёт", path: "My Report.pdf", scope: "group" },
    ]);
  });

  it("does not read a file shown inside code", () => {
    const reading = readAnswerMedia("Пиши так: `![](/workspace/personal/a.jpg)`\n\n```\n![](/workspace/personal/b.jpg)\n```");

    expect(reading.files).toEqual([]);
    expect(reading.unread).toBe(0);
  });

  it("reports web media and other addresses apart from workspace files", () => {
    const reading = readAnswerMedia([
      "![](https://example.com/photo.jpg)",
      "",
      "![](recipes/duchesse.jpg)",
      "",
      "![](/workspace/inbox/a.jpg)",
      "",
      "![](/workspace/personal)",
    ].join("\n"));

    expect(reading.files).toEqual([]);
    expect(reading.foreign).toEqual([
      { address: "https://example.com/photo.jpg", remote: true },
      { address: "recipes/duchesse.jpg", remote: false },
      { address: "/workspace/inbox/a.jpg", remote: false },
      { address: "/workspace/personal", remote: false },
    ]);
  });

  it("counts workspace paths Markdown did not read as media", () => {
    const reading = readAnswerMedia([
      "![фото](/workspace/personal/My File.jpg)",
      "",
      "[отчёт](/workspace/personal/report.pdf)",
      "",
      "<details>",
      "![a](/workspace/personal/a.jpg)",
      "</details>",
    ].join("\n"));

    expect(reading.files).toEqual([]);
    expect(reading.unread).toBe(3);
  });

  it("keeps a file that stands alone in its place", () => {
    expect(laidOut("Текст\n\n![a](/workspace/personal/a.jpg)\n\nЕщё")).toBe("Текст\n\nTOKEN0\n\nЕщё");
  });

  it("replaces a paragraph of files alone with one block per file", () => {
    expect(laidOut("![a](/workspace/personal/a.jpg)\n![b](/workspace/personal/b.jpg)")).toBe("TOKEN0\n\nTOKEN1");
  });

  it("moves a file out of a sentence to a block right after it", () => {
    expect(laidOut("Смотри ![a](/workspace/personal/a.jpg) вот\n\nДальше")).toBe("Смотри вот\n\nTOKEN0\n\nДальше");
    expect(laidOut("Текст ![a](/workspace/personal/a.jpg)")).toBe("Текст\n\nTOKEN0");
  });

  it("replaces a list of files alone with one block per file, apart from the line before it", () => {
    // Left as `-` lines under "Вот файлы:", the empty items would turn that line into a heading.
    expect(laidOut("Вот файлы:\n- ![Отчёт](/workspace/personal/a.pdf)\n- ![Фото](/workspace/personal/b.jpg)"))
      .toBe("Вот файлы:\n\nTOKEN0\n\nTOKEN1");
  });

  it("takes out a list item, a heading or a quote that held nothing but a file", () => {
    expect(laidOut("- текст\n- ![a](/workspace/personal/a.jpg)\n- ещё")).toBe("- текст\n- ещё\n\nTOKEN0");
    expect(laidOut("- текст\n- ![a](/workspace/personal/a.jpg)")).toBe("- текст\n\nTOKEN0");
    expect(laidOut("## ![a](/workspace/personal/a.jpg)\nТекст")).toBe("TOKEN0\n\nТекст");
    expect(laidOut("Текст\n\n> ![a](/workspace/personal/a.jpg)")).toBe("Текст\n\nTOKEN0");
    expect(laidOut("## Обложка ![a](/workspace/personal/a.jpg)")).toBe("## Обложка\n\nTOKEN0");
  });

  it("takes the emphasis around a file out with it", () => {
    expect(laidOut("Смотри **![a](/workspace/personal/a.jpg)** вот")).toBe("Смотри вот\n\nTOKEN0");
  });

  it("moves files out of a list to blocks right after the list, in order", () => {
    const markdown = "1. Шаг ![a](/workspace/personal/a.jpg)\n2. Второй ![b](/workspace/personal/b.jpg)\n\nКонец";

    expect(laidOut(markdown)).toBe("1. Шаг\n2. Второй\n\nTOKEN0\n\nTOKEN1\n\nКонец");
  });
});
