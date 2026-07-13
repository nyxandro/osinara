/**
 * Filesystem workspace file record serialization tests.
 *
 * Constructs covered:
 * - `createWorkspaceFileRecord`: converts filesystem timestamps to strict JSON values.
 */
import { describe, expect, it } from "vitest";

import { createWorkspaceFileRecord } from "./workspace-file-record.js";

describe("createWorkspaceFileRecord", () => {
  it("returns an ISO timestamp instead of a non-plain Date object", () => {
    const record = createWorkspaceFileRecord({
      byteSize: 12,
      contentSha256: "a".repeat(64),
      mediaType: "text/plain; charset=utf-8",
      path: "notes/example.txt",
      scope: "personal",
      updatedAt: new Date("2026-07-12T16:00:00.000Z"),
    });

    expect(record).toEqual({
      byteSize: 12,
      contentSha256: "a".repeat(64),
      mediaType: "text/plain; charset=utf-8",
      path: "notes/example.txt",
      scope: "personal",
      updatedAt: "2026-07-12T16:00:00.000Z",
    });
    expect(Object.values(record).some((value) => value instanceof Date)).toBe(false);
  });
});
