/**
 * Telegram attachment import tool result tests.
 *
 * Constructs covered:
 * - External imports return the canonical sandbox path accepted by guarded `read_file`.
 * - Family imports preserve the trusted relative workspace path contract.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  authorization: vi.fn(),
  materialize: vi.fn(),
}));

vi.mock("./attachments/telegram-attachment-materializer.js", () => ({
  materializeTelegramAttachment: dependencies.materialize,
}));
vi.mock("./workspaces/workspace-context.js", () => ({
  requireWorkspaceAuthorization: dependencies.authorization,
}));

import importTelegramAttachment from "./tools/import_telegram_attachment.js";

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000099";
const context = { callId: "call-1" } as ToolContext;

describe("import_telegram_attachment result", () => {
  beforeEach(() => {
    dependencies.authorization.mockReset();
    dependencies.materialize.mockReset();
    dependencies.materialize.mockResolvedValue({
      mediaType: "text/markdown",
      path: "inbox/42/notes.md",
      scope: "group",
      telegramMessageId: "42",
    });
  });

  it("returns an absolute external group path ready for guarded read_file", async () => {
    dependencies.authorization.mockReturnValue({ groupType: "external" });

    await expect(importTelegramAttachment.execute({
      attachmentId: ATTACHMENT_ID,
    }, context)).resolves.toMatchObject({
      path: "/workspace/group/inbox/42/notes.md",
      scope: "group",
    });
  });

  it("preserves the family-relative path", async () => {
    dependencies.authorization.mockReturnValue({ groupType: "family_private" });
    dependencies.materialize.mockResolvedValue({
      mediaType: "text/markdown",
      path: "inbox/groups/group-1/42/notes.md",
      scope: "family",
      telegramMessageId: "42",
    });

    await expect(importTelegramAttachment.execute({
      attachmentId: ATTACHMENT_ID,
    }, context)).resolves.toMatchObject({
      path: "inbox/groups/group-1/42/notes.md",
      scope: "family",
    });
  });
});
