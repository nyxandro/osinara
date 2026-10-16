/**
 * Integration-facing tool usability contract tests.
 *
 * Constructs covered:
 * - Workspace image schema: required intent and scope with runtime-only source exclusivity.
 * - Telegram attachment import schema: one required UUID and no undeclared fields.
 * - Workspace file tool descriptions: paths are relative to the authorized scope root.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import importTelegramAttachment from "./tools/import_telegram_attachment.js";
import inspectWorkspaceImage from "./tools/inspect_workspace_image.js";
import sendWorkspaceFile from "./tools/send_workspace_file.js";
import { removeGroupFileTool } from "./workspaces/remove-group-file-tool.js";

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000041";

function schemaOf(tool: { inputSchema: unknown }): z.ZodType {
  return tool.inputSchema as z.ZodType;
}

describe("integration tool usability contracts", () => {
  it("requires image question and scope in the model schema while source exclusivity stays runtime-validated", () => {
    const schema = schemaOf(inspectWorkspaceImage);
    const jsonSchema = z.toJSONSchema(schema) as { required?: string[] };

    expect(jsonSchema.required).toEqual(expect.arrayContaining(["question", "scope"]));
    expect(schema.safeParse({ path: "photos/image.png", scope: "personal" }).success).toBe(false);
    expect(schema.safeParse({ path: "photos/image.png", question: "Что изображено?" }).success).toBe(false);
    expect(schema.safeParse({
      attachmentId: ATTACHMENT_ID,
      path: "photos/image.png",
      question: "Что изображено?",
      scope: "personal",
    }).success).toBe(true);
  });

  it("publishes a strict required attachmentId schema", () => {
    const schema = schemaOf(importTelegramAttachment);
    const jsonSchema = z.toJSONSchema(schema) as {
      additionalProperties?: boolean;
      required?: string[];
    };

    expect(jsonSchema.required).toContain("attachmentId");
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(schema.safeParse({ attachmentId: ATTACHMENT_ID }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ attachmentId: ATTACHMENT_ID, path: "file.pdf" }).success).toBe(false);
  });

  it("describes workspace paths as relative to the selected scope without repeating its name", () => {
    expect(inspectWorkspaceImage.description).toContain('"path":"photos/image.png"');
    expect(inspectWorkspaceImage.description).not.toContain('"path":"personal/');
    expect(sendWorkspaceFile.description).toMatch(/relative to the root of the chosen scope/iu);
    expect(removeGroupFileTool.description).toMatch(/relative to the root of the group scope/iu);
  });

  it("documents enough information to recover from each integration tool result", () => {
    for (const tool of [inspectWorkspaceImage, importTelegramAttachment, sendWorkspaceFile]) {
      expect(tool.description).toMatch(/When to use:/u);
      expect(tool.description).toMatch(/When not to use:/u);
      expect(tool.description).toMatch(/Input:/u);
      expect(tool.description).toMatch(/Result:/u);
      expect(tool.description).toMatch(/Error:/u);
    }
  });
});
