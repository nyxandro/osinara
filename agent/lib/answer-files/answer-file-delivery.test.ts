/**
 * An answer with files, prepared for Telegram: every file inside the rich message where the model
 * placed it, and a visible line where a file could not go.
 *
 * Constructs covered:
 * - A file becomes a `tg://<kind>?id=` media block with its caption, uploaded once however often
 *   it is shown; an answer with a file is rich even without other markup, also inside a block the
 *   model collapsed.
 * - A file that cannot go leaves a line with the reason and a stable code; the rest still goes.
 * - When the answer cannot be a rich message, no file goes and every place says why.
 * - Preparing the same turn twice gives the same text, so a replay matches its first attempt.
 */
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { prepareAnswerFiles, presentTelegramAnswer } from "./answer-file-delivery.js";
import type { AnswerFileMeasure, AnswerFileProblem, AnswerFileResolution, ResolvedAnswerFile } from "./answer-file-resolution.js";

const auth = { familyId: "family-1", role: "owner" } as WorkspaceAuthorization;

function file(path: string, kind: ResolvedAnswerFile["kind"], byteSize = 10): ResolvedAnswerFile {
  return {
    byteSize, bytes: Buffer.from(path), fileName: path.split("/").at(-1)!, kind,
    mediaType: kind === "photo" ? "image/jpeg" : "application/pdf", path, scope: "personal", sha256: `sha-${path}`,
  };
}

function resolverOf(files: Record<string, ResolvedAnswerFile | AnswerFileProblem>) {
  const found = (path: string) => {
    const file = files[path];
    if (file === undefined) throw new Error(`unexpected path ${path}`);
    return file;
  };
  return {
    load: vi.fn(async (_auth: unknown, reference: { path: string }): Promise<AnswerFileResolution> => {
      const file = found(reference.path);
      return typeof file === "string" ? { ok: false, problem: file } : { file, ok: true };
    }),
    measure: vi.fn(async (_auth: unknown, reference: { path: string }): Promise<AnswerFileMeasure> => {
      const file = found(reference.path);
      if (typeof file === "string") return { ok: false, problem: file };
      const { byteSize, fileName, path, scope } = file;
      return { file: { byteSize, fileName, path, scope }, ok: true };
    }),
  };
}

async function present(markdown: string, files: Record<string, ResolvedAnswerFile | AnswerFileProblem>) {
  const resolver = resolverOf(files);
  const prepared = await prepareAnswerFiles({ auth: () => auth, markdown, resolver, turnId: "turn-1" });
  return { chunks: presentTelegramAnswer(prepared, { replyButtons: false }), prepared, resolver };
}

describe("an answer with files", () => {
  it("puts a photo where the model placed it, with its caption", async () => {
    const { chunks } = await present(
      "Вот рецепт.\n\n![Обложка](/workspace/personal/recipes/d.jpg)\n\n### Шаги\n- раз",
      { "recipes/d.jpg": file("recipes/d.jpg", "photo") },
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ format: "rich" });
    expect(chunks[0]!.text).toBe("Вот рецепт.\n\n![](tg://photo?id=f0 \"Обложка\")\n\n### Шаги\n- раз");
    expect(chunks[0]!.media).toEqual([
      { bytes: Buffer.from("recipes/d.jpg"), fileName: "d.jpg", id: "f0", kind: "photo", mediaType: "image/jpeg", sha256: "sha-recipes/d.jpg" },
    ]);
  });

  it("sends an answer with a file rich even without other markup", async () => {
    const { chunks } = await present("Готово, отчёт ниже.\n\n![](/workspace/personal/report.pdf)", {
      "report.pdf": file("report.pdf", "document"),
    });

    expect(chunks).toEqual([{
      format: "rich",
      media: [expect.objectContaining({ id: "f0", kind: "document" })],
      pacing: "immediate",
      text: "Готово, отчёт ниже.\n\n![](tg://document?id=f0)",
    }]);
  });

  it("uploads a file shown twice once and escapes its captions", async () => {
    const { chunks, resolver } = await present(
      "![Фото \"до\"](/workspace/personal/a.jpg)\n\nТекст.\n\n![](/workspace/personal/a.jpg \"После\\\\\")",
      { "a.jpg": file("a.jpg", "photo") },
    );

    expect(resolver.measure).toHaveBeenCalledTimes(1);
    expect(resolver.load).toHaveBeenCalledTimes(1);
    expect(chunks[0]!.text).toBe("![](tg://photo?id=f0 \"Фото \\\"до\\\"\")\n\nТекст.\n\n![](tg://photo?id=f0 \"После\\\\\")");
    expect(chunks[0]!.media.map((upload) => upload.id)).toEqual(["f0"]);
  });

  it("keeps files inside a block the model collapsed", async () => {
    const steps = Array.from({ length: 8 }, (_, index) => `${index + 1}. Шаг номер ${index + 1}`).join("\n");
    const { chunks } = await present(
      `Рецепт в восемь шагов.\n\n![](/workspace/personal/cover.jpg)\n\n<details><summary>Шаги</summary>\n\n${steps}\n\n` +
        "![](/workspace/personal/step.jpg)\n\n</details>",
      { "cover.jpg": file("cover.jpg", "photo"), "step.jpg": file("step.jpg", "photo") },
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toMatch(/^Рецепт в восемь шагов\.\n\n!\[\]\(tg:\/\/photo\?id=f0\)\n\n<details><summary>Шаги<\/summary>/u);
    expect(chunks[0]!.text).toContain("![](tg://photo?id=f1)\n\n</details>");
    expect(chunks[0]!.media.map((upload) => upload.id)).toEqual(["f0", "f1"]);
  });

  it("never collapses a long answer with files for the model", async () => {
    const steps = Array.from({ length: 8 }, (_, index) => `${index + 1}. Шаг номер ${index + 1}`).join("\n");
    const { chunks } = await present(`![](/workspace/personal/cover.jpg)\n\n${steps}`, { "cover.jpg": file("cover.jpg", "photo") });

    expect(chunks[0]!.text).toBe(`![](tg://photo?id=f0)\n\n${steps}`);
  });

  it("leaves a line with the reason where a file cannot go and sends the rest", async () => {
    const { chunks, prepared } = await present(
      "![](/workspace/personal/gone.jpg)\n\n![](/workspace/family/secret.pdf)\n\n![](/workspace/personal/ok.pdf)",
      {
        "gone.jpg": "not_found",
        "ok.pdf": file("ok.pdf", "document"),
        "secret.pdf": "forbidden",
      },
    );

    expect(prepared.problems).toEqual([
      { code: "AGENT_ANSWER_FILE_NOT_FOUND", path: "/workspace/personal/gone.jpg" },
      { code: "AGENT_ANSWER_FILE_FORBIDDEN", path: "/workspace/family/secret.pdf" },
    ]);
    expect(chunks[0]!.text).toBe([
      "⚠️ Не удалось приложить «gone.jpg»: файл не найден (AGENT_ANSWER_FILE_NOT_FOUND)",
      "⚠️ Не удалось приложить «secret.pdf»: нет доступа к этой папке из текущего чата (AGENT_ANSWER_FILE_FORBIDDEN)",
      "![](tg://document?id=f0)",
    ].join("\n\n"));
  });

  it("says why on every place when the answer cannot be a rich message", async () => {
    const wide = `${Array.from({ length: 21 }, (_, index) => `к${index}`).join(" | ")}\n${Array(21).fill("---").join(" | ")}`;
    const { chunks } = await present(`${wide}\n\n![](/workspace/personal/a.pdf)`, { "a.pdf": file("a.pdf", "document") });

    expect(chunks.every((chunk) => chunk.media.length === 0)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain(
      "⚠️ Не удалось приложить «a.pdf»: ответ не поместился в оформленное сообщение (AGENT_ANSWER_FILES_FORMAT_UNFIT)",
    );
    expect(chunks.map((chunk) => chunk.text).join("\n")).not.toMatch(/OSINARAFILE/u);
  });

  it("keeps a caption to text: its links pass the same filter as the answer, and it stays short", async () => {
    const { chunks } = await present(
      `![](/workspace/personal/a.jpg "[клик](tg://resolve?domain=evil) и [сайт](https://example.com)")\n\n![${"п".repeat(1_500)}](/workspace/personal/b.jpg)`,
      { "a.jpg": file("a.jpg", "photo"), "b.jpg": file("b.jpg", "photo") },
    );

    const text = chunks[0]!.text;
    expect(text).not.toContain("](tg://resolve");
    expect(text).toContain("клик (tg://resolve?domain=evil)");
    expect(text).toContain(`"${"п".repeat(1_023)}…"`);
  });

  it("sends no file where the presentation could not keep it a block of its own", async () => {
    const wide = `${Array.from({ length: 21 }, (_, index) => `к${index}`).join(" | ")}\n${Array(21).fill("---").join(" | ")}`;
    const resolver = resolverOf({ "a.pdf": file("a.pdf", "document") });
    const prepared = await prepareAnswerFiles({ auth: () => auth, markdown: `${wide}\n\n![](/workspace/personal/a.pdf)\n\nБерём?`, resolver, turnId: "turn-1" });

    // With reply buttons a too-wide answer goes as literal paragraphs, where Markdown media is not read.
    const chunks = presentTelegramAnswer(prepared, { replyButtons: true });

    expect(chunks.every((chunk) => chunk.media.length === 0 && !chunk.text.includes("tg://"))).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("AGENT_ANSWER_FILES_FORMAT_UNFIT");
  });

  it("sends no file when its caption would push the message over Telegram's limit", async () => {
    const { chunks } = await present(`${"а".repeat(32_600)}\n\n![${"п".repeat(1_000)}](/workspace/personal/a.jpg)`, {
      "a.jpg": file("a.jpg", "photo"),
    });

    expect(chunks.every((chunk) => chunk.media.length === 0)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("AGENT_ANSWER_FILES_FORMAT_UNFIT");
  });

  it("reads only the files the answer can carry", async () => {
    const names = Array.from({ length: 52 }, (_, index) => `f${index}.pdf`);
    const markdown = names.map((name) => `![](/workspace/personal/${name})`).join("\n\n");

    const { prepared, resolver } = await present(markdown, Object.fromEntries(names.map((name) => [name, file(name, "document")])));

    expect(resolver.measure).toHaveBeenCalledTimes(52);
    expect(resolver.load).toHaveBeenCalledTimes(50);
    expect(prepared.problems.map((problem) => problem.code)).toEqual(Array(2).fill("AGENT_ANSWER_FILES_LIMIT_EXCEEDED"));
  });

  it("names the answer limit on a file that no longer fits", async () => {
    const big = 30 * 1024 * 1024;
    const { chunks } = await present("![](/workspace/personal/a.zip)\n\n![](/workspace/personal/b.zip)", {
      "a.zip": file("a.zip", "document", big),
      "b.zip": file("b.zip", "document", big),
    });

    expect(chunks[0]!.text).toBe([
      "![](tg://document?id=f0)",
      "⚠️ Не удалось приложить «b.zip»: в одно сообщение помещается не больше 50 файлов и 47 МБ вместе (AGENT_ANSWER_FILES_LIMIT_EXCEEDED)",
    ].join("\n\n"));
  });

  it("does not touch an answer without files and never asks for workspace rights", async () => {
    const authorize = vi.fn(() => auth);
    const prepared = await prepareAnswerFiles({ auth: authorize, markdown: "Просто ответ", resolver: resolverOf({}), turnId: "turn-1" });

    expect(prepared).toEqual({ files: null, markdown: "Просто ответ", problems: [], source: null });
    expect(authorize).not.toHaveBeenCalled();
    expect(presentTelegramAnswer(prepared, { replyButtons: false })).toEqual([
      { format: "plain", media: [], pacing: "immediate", text: "Просто ответ" },
    ]);
  });

  it("prepares the same turn the same way twice", async () => {
    const files = { "a.jpg": file("a.jpg", "photo") };
    const first = await present("![](/workspace/personal/a.jpg)", files);
    const second = await present("![](/workspace/personal/a.jpg)", files);

    expect(second.prepared.markdown).toBe(first.prepared.markdown);
  });
});
