/**
 * Personal memory export formatting tests.
 *
 * Constructs covered:
 * - JSON is versioned and Markdown quotes untrusted multiline memory content.
 */
import { describe, expect, it } from "vitest";

import { formatMemoryExportFiles } from "./memory-export.js";

describe("formatMemoryExportFiles", () => {
  it("produces complete JSON and quoted Markdown", () => {
    const files = formatMemoryExportFiles({
      exportedAt: "2026-07-12T12:00:00.000Z",
      records: [{
        author: { status: "current_member", telegramUserId: null, userId: "user-1" },
        confirmation: "user_confirmed",
        content: "Первая строка\n# недоверенный заголовок",
        createdAt: "2026-07-12T10:00:00.000Z",
        embeddingStatus: "indexed",
        id: "00000000-0000-4000-8000-000000000001",
        kind: "fact",
        messageThreadId: null,
        scope: "personal",
        sensitivity: "normal",
        source: "eve:session:turn",
        updatedAt: "2026-07-12T10:00:00.000Z",
      }],
      schemaVersion: 1,
    });

    expect(JSON.parse(files.json)).toMatchObject({ schemaVersion: 1 });
    expect(files.markdown).toContain("> Первая строка\n> # недоверенный заголовок");
  });
});
