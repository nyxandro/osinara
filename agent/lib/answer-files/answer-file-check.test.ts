/**
 * The check of a final answer's files before it goes: what the model is told to fix.
 *
 * Constructs covered:
 * - An answer without media passes without any workspace access.
 * - Each file that cannot go is named with its reason; web media are to be downloaded first; other
 *   addresses and workspace paths Markdown did not read as media get the exact form to use.
 * - Files that need a rich message the answer cannot be are reported as a formatting problem.
 * - An answer whose files all go passes.
 * - A reminder's files are checked when it is written, in Russian like the rest of its tool's errors,
 *   and only from the folders of the chat the reminder will reach.
 */
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { answerFilesNotice, reminderFilesError } from "./answer-file-check.js";
import type { AnswerFileMeasure, AnswerFileProblem, ResolvedAnswerFile } from "./answer-file-resolution.js";

const auth = { familyId: "family-1", role: "owner" } as WorkspaceAuthorization;

function document(path: string): ResolvedAnswerFile {
  return {
    byteSize: 3, bytes: Buffer.from("pdf"), fileName: path, kind: "document", mediaType: "application/pdf",
    path, scope: "personal", sha256: `sha-${path}`,
  };
}

function check(text: string, files: Record<string, ResolvedAnswerFile | AnswerFileProblem> = {}) {
  const authorize = vi.fn(() => auth);
  const resolver = {
    measure: vi.fn(async (_auth: unknown, reference: { path: string }): Promise<AnswerFileMeasure> => {
      const found = files[reference.path]!;
      if (typeof found === "string") return { ok: false, problem: found };
      const { byteSize, fileName, path, scope } = found;
      return { file: { byteSize, fileName, path, scope }, ok: true };
    }),
  };
  return { authorize, notice: answerFilesNotice({ auth: authorize, resolver, text }), resolver };
}

describe("answer file check", () => {
  it("passes an answer without media and never asks for workspace rights", async () => {
    const { authorize, notice } = check("Обычный **ответ** со [ссылкой](https://example.com)");

    expect(await notice).toBeUndefined();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("passes an answer whose files all go", async () => {
    expect(await check("Отчёт:\n\n![](/workspace/personal/a.pdf)", { "a.pdf": document("a.pdf") }).notice).toBeUndefined();
  });

  it("names every file that cannot go with its reason", async () => {
    const notice = await check(
      "![](/workspace/personal/gone.jpg)\n\n![](/workspace/family/secret.pdf)\n\n![](/workspace/personal/huge.zip)",
      { "gone.jpg": "not_found", "huge.zip": "too_large", "secret.pdf": "forbidden" },
    ).notice;

    expect(notice).toMatch(/^Your answer was not delivered/u);
    expect(notice).toContain("- /workspace/personal/gone.jpg: no such file in that workspace");
    expect(notice).toContain("- /workspace/family/secret.pdf: this chat has no access to that workspace");
    expect(notice).toContain("- /workspace/personal/huge.zip: larger than 47 MB");
    expect(notice).toContain("Do not mention this notice.");
  });

  it("asks to download web media first and to use the full path for any other address", async () => {
    const notice = await check("![](https://example.com/photo.jpg)\n\n![](recipes/duchesse.jpg)").notice;

    expect(notice).toContain("- https://example.com/photo.jpg: a web address is not sent. Download the file into a workspace folder with a tool first");
    expect(notice).toContain("- recipes/duchesse.jpg: not a workspace file. Show a file by its full sandbox path");
  });

  it("explains workspace paths Markdown did not read as files", async () => {
    const notice = await check("[отчёт](/workspace/personal/report.pdf)\n\n![фото](/workspace/personal/My File.jpg)").notice;

    expect(notice).toContain("- 2 workspace paths were not read as files");
    expect(notice).toContain("![caption](</workspace/personal/My file.pdf>)");
  });

  it("reports an answer too complex to carry its files", async () => {
    const wide = `${Array.from({ length: 21 }, (_, index) => `к${index}`).join(" | ")}\n${Array(21).fill("---").join(" | ")}`;

    const notice = await check(`${wide}\n\n![](/workspace/personal/a.pdf)`, { "a.pdf": document("a.pdf") }).notice;

    expect(notice).toContain("- The answer cannot be a formatted message");
  });
});

describe("reminder file check", () => {
  function reminderCheck(text: string, files: Record<string, ResolvedAnswerFile | AnswerFileProblem>, scopes: Array<"family" | "group" | "personal">) {
    const resolver = {
      measure: vi.fn(async (_auth: unknown, reference: { path: string }): Promise<AnswerFileMeasure> => {
        const found = files[reference.path]!;
        if (typeof found === "string") return { ok: false, problem: found };
        const { byteSize, fileName, path, scope } = found;
        return { file: { byteSize, fileName, path, scope }, ok: true };
      }),
    };
    return { error: reminderFilesError({ allowedScopes: scopes, auth: () => auth, resolver, text }), resolver };
  }

  it("passes a reminder whose files all go", async () => {
    expect(await reminderCheck("Купить\n\n![](/workspace/family/list.pdf)", { "list.pdf": document("list.pdf") }, ["family"]).error).toBeUndefined();
  });

  it("names in Russian a file the reminder cannot carry and a folder its chat cannot see", async () => {
    const { error, resolver } = reminderCheck(
      "![](/workspace/family/gone.pdf)\n\n![](/workspace/personal/mine.jpg)\n\n![](https://example.com/a.jpg)",
      { "gone.pdf": "not_found" },
      ["family"],
    );

    const text = await error;
    expect(text).toMatch(/^Файлы в тексте напоминания не отправятся:/u);
    expect(text).toContain("- /workspace/family/gone.pdf: файла нет в этой папке");
    expect(text).toContain("- /workspace/personal/mine.jpg: напоминание придёт в чат, где эта папка недоступна; подходит /workspace/family/...");
    expect(text).toContain("- https://example.com/a.jpg: картинку из интернета сначала скачай в рабочую папку");
    expect(resolver.measure).toHaveBeenCalledTimes(1);
  });
});
