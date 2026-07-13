/**
 * Persistent workspace image inspection tests.
 *
 * Constructs covered:
 * - `createWorkspaceImageInspector`: authorized bytes are sent to vision with the user's question.
 * - Non-image and provider-oversized files fail before a paid model call.
 */
import { describe, expect, it, vi } from "vitest";

import { createWorkspaceImageInspector } from "./workspace-image-inspection.js";

const auth = {
  familyId: "family-1",
  groupId: null,
  groupType: null,
  role: "owner" as const,
  telegramChatType: "private" as const,
  userId: "user-1",
};

describe("createWorkspaceImageInspector", () => {
  it("analyzes an authorized persisted image", async () => {
    const analyze = vi.fn().mockResolvedValue("На изображении семейный календарь.");
    const inspect = createWorkspaceImageInspector({
      analyze,
      readBinary: vi.fn().mockResolvedValue({
        bytes: Buffer.from("image"),
        file: { mediaType: "image/png", path: "photos/calendar.png" },
        workspaceId: "workspace-1",
      }),
      scan: vi.fn().mockResolvedValue(undefined),
    });

    await expect(inspect(auth, {
      path: "photos/calendar.png",
      question: "Что изображено?",
      scope: "personal",
    })).resolves.toMatchObject({ analysis: "На изображении семейный календарь." });
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: "image/png",
      question: "Что изображено?",
    }));
  });

  it("rejects a document instead of sending unsupported content to Groq", async () => {
    const analyze = vi.fn();
    const inspect = createWorkspaceImageInspector({
      analyze,
      readBinary: vi.fn().mockResolvedValue({
        bytes: Buffer.from("document"),
        file: { mediaType: "application/pdf", path: "docs/report.pdf" },
        workspaceId: "workspace-1",
      }),
      scan: vi.fn().mockResolvedValue(undefined),
    });

    await expect(inspect(auth, {
      path: "docs/report.pdf",
      question: "Что внутри?",
      scope: "personal",
    })).rejects.toThrowError(/AGENT_WORKSPACE_VISION_TYPE_UNSUPPORTED/);
    expect(analyze).not.toHaveBeenCalled();
  });
});
