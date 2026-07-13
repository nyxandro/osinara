/**
 * Workspace file metadata tests.
 *
 * Constructs covered:
 * - `detectWorkspaceFileMetadata`: magic-byte MIME preservation after sandbox file operations.
 * - Search text extraction remains restricted to supported UTF-8 files.
 */
import { describe, expect, it } from "vitest";

import { detectWorkspaceFileMetadata } from "./workspace-file-metadata.js";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);

describe("detectWorkspaceFileMetadata", () => {
  it("keeps the actual image MIME after a shell move", async () => {
    await expect(detectWorkspaceFileMetadata(PNG_BYTES, "photos/image.png"))
      .resolves.toEqual({ extractedText: null, mediaType: "image/png" });
  });

  it("indexes supported UTF-8 documents", async () => {
    await expect(detectWorkspaceFileMetadata(Buffer.from("family notes"), "notes/readme.md"))
      .resolves.toEqual({ extractedText: "family notes", mediaType: "text/markdown" });
  });
});
