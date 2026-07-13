/**
 * Telegram attachment validation tests.
 *
 * Constructs covered:
 * - `validateAttachmentContent`: actual byte type, extension, and declared MIME agreement.
 * - UTF-8 structured text acceptance without treating arbitrary binary data as text.
 */
import { describe, expect, it } from "vitest";

import { validateAttachmentContent } from "./attachment-policy.js";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);

describe("validateAttachmentContent", () => {
  it("accepts an image only when bytes, extension, and MIME agree", async () => {
    await expect(validateAttachmentContent({
      bytes: PNG_BYTES,
      declaredMediaType: "image/png",
      fileName: "Снимок.png",
      kind: "photo",
    })).resolves.toEqual({ fileName: "Снимок.png", mediaType: "image/png" });
  });

  it("rejects a renamed payload instead of trusting Telegram metadata", async () => {
    await expect(validateAttachmentContent({
      bytes: PNG_BYTES,
      declaredMediaType: "application/pdf",
      fileName: "договор.pdf",
      kind: "document",
    })).rejects.toThrowError(/AGENT_ATTACHMENT_TYPE_MISMATCH/);
  });

  it("accepts supported UTF-8 text documents when binary detection is absent", async () => {
    await expect(validateAttachmentContent({
      bytes: Buffer.from("name,value\nчай,2\n", "utf8"),
      declaredMediaType: "text/csv",
      fileName: "покупки.csv",
      kind: "document",
    })).resolves.toEqual({ fileName: "покупки.csv", mediaType: "text/csv" });
  });

  it("rejects unsupported executable content", async () => {
    await expect(validateAttachmentContent({
      bytes: Buffer.from("MZ" + "\0".repeat(128), "binary"),
      declaredMediaType: "application/octet-stream",
      fileName: "invoice.exe",
      kind: "document",
    })).rejects.toThrowError(/AGENT_ATTACHMENT_TYPE_FORBIDDEN/);
  });
});
