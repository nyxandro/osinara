/**
 * Persistent workspace PDF vision tests.
 *
 * Constructs covered:
 * - `createWorkspacePdfInspector`: authorized PDF pages are rendered and sent to vision.
 * - Non-PDF files and invalid page starts fail before rendering or model usage.
 */
import { describe, expect, it, vi } from "vitest";

import { createWorkspacePdfInspector } from "./workspace-pdf-inspection.js";

const auth = {
  familyId: "family-1",
  groupId: null,
  groupType: null,
  role: "owner" as const,
  telegramChatType: "private" as const,
  userId: "user-1",
};

describe("createWorkspacePdfInspector", () => {
  it("renders at most three pages and analyzes them with vision", async () => {
    const analyze = vi.fn().mockResolvedValue("Страницы содержат квартальный отчёт.");
    const render = vi.fn().mockResolvedValue({
      pages: [
        { bytes: Buffer.from("page-1"), pageNumber: 4 },
        { bytes: Buffer.from("page-2"), pageNumber: 5 },
      ],
      totalPages: 5,
    });
    const inspect = createWorkspacePdfInspector({
      analyze,
      readBinary: vi.fn().mockResolvedValue({
        bytes: Buffer.from("pdf"),
        file: { mediaType: "application/pdf", path: "docs/report.pdf", scope: "personal" },
        workspaceId: "workspace-1",
      }),
      render,
      scan: vi.fn().mockResolvedValue(undefined),
    });

    await expect(inspect(auth, {
      path: "docs/report.pdf",
      question: "Кратко изложи факты на этих страницах",
      scope: "personal",
      startPage: 4,
    })).resolves.toEqual({
      analysis: "Страницы содержат квартальный отчёт.",
      analyzedPages: [4, 5],
      path: "docs/report.pdf",
      scope: "personal",
      totalPages: 5,
    });
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ startPage: 4 }));
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ pages: expect.any(Array) }));
  });

  it("rejects a renamed non-PDF before calling the renderer", async () => {
    const render = vi.fn();
    const inspect = createWorkspacePdfInspector({
      analyze: vi.fn(),
      readBinary: vi.fn().mockResolvedValue({
        bytes: Buffer.from("text"),
        file: { mediaType: "text/plain", path: "docs/report.pdf", scope: "personal" },
        workspaceId: "workspace-1",
      }),
      render,
      scan: vi.fn().mockResolvedValue(undefined),
    });

    await expect(inspect(auth, {
      path: "docs/report.pdf",
      question: "Что внутри?",
      scope: "personal",
      startPage: 1,
    })).rejects.toThrowError(/AGENT_WORKSPACE_PDF_TYPE_INVALID/);
    expect(render).not.toHaveBeenCalled();
  });
});
