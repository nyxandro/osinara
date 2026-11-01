/**
 * Telegram attachment validation tests.
 *
 * Constructs covered:
 * - `validateAttachmentContent`: safe names and content-derived MIME for arbitrary documents.
 * - Native Telegram photos remain restricted to actual image bytes.
 * - UTF-8 structured text remains recognizable without trusting arbitrary binary declarations.
 */
import { describe, expect, it } from "vitest";

import { validateAttachmentContent } from "./attachment-policy.js";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);

describe("validateAttachmentContent", () => {
  it("accepts actual image bytes through Telegram's native photo transport", async () => {
    await expect(validateAttachmentContent({
      bytes: PNG_BYTES,
      declaredMediaType: "image/png",
      fileName: "Снимок.png",
      kind: "photo",
    })).resolves.toEqual({ fileName: "Снимок.png", mediaType: "image/png" });
  });

  it("accepts a renamed document while retaining its detected content type", async () => {
    await expect(validateAttachmentContent({
      bytes: PNG_BYTES,
      declaredMediaType: "application/pdf",
      fileName: "договор.pdf",
      kind: "document",
    })).resolves.toEqual({ fileName: "договор.pdf", mediaType: "image/png" });
  });

  it("accepts supported UTF-8 text documents when binary detection is absent", async () => {
    await expect(validateAttachmentContent({
      bytes: Buffer.from("name,value\nчай,2\n", "utf8"),
      declaredMediaType: "text/csv",
      fileName: "покупки.csv",
      kind: "document",
    })).resolves.toEqual({ fileName: "покупки.csv", mediaType: "text/csv" });
  });

  it("accepts an APK-like archive regardless of the generic Telegram MIME", async () => {
    const emptyZip = Buffer.from("504b0506000000000000000000000000000000000000", "hex");

    await expect(validateAttachmentContent({
      bytes: emptyZip,
      declaredMediaType: "application/octet-stream",
      fileName: "application.apk",
      kind: "document",
    })).resolves.toEqual({ fileName: "application.apk", mediaType: "application/zip" });
  });

  it("stores an opaque unknown document with a conservative binary media type", async () => {
    await expect(validateAttachmentContent({
      bytes: Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]),
      declaredMediaType: "application/x-user-defined",
      fileName: "payload.custom",
      kind: "document",
    })).resolves.toEqual({
      fileName: "payload.custom",
      mediaType: "application/octet-stream",
    });
  });

  it("rejects non-image bytes sent through Telegram's native photo transport", async () => {
    const emptyZip = Buffer.from("504b0506000000000000000000000000000000000000", "hex");

    await expect(validateAttachmentContent({
      bytes: emptyZip,
      fileName: "photo.jpg",
      kind: "photo",
    })).rejects.toThrowError(/AGENT_ATTACHMENT_TYPE_MISMATCH/);
  });
});
