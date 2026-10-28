/**
 * A file of the answer, found with the chat's rights and shown the way Telegram accepts it.
 *
 * Constructs covered:
 * - A file is measured with the chat's rights before any byte is read; one over the answer limit
 *   is refused without reading it.
 * - JPEG, PNG and WebP within Telegram's photo limits are photos; any other picture is a document.
 * - MP4 is a video and MP3 an audio track, as tried in a live rich message; a GIF and anything else
 *   is a document.
 * - Workspace refusals become problems the model can fix; an unexpected failure is not hidden.
 * - One answer carries at most 50 files and 47 MiB together; a file used twice counts once.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { admitAnswerFiles, createAnswerFileResolver, type MeasuredAnswerFile } from "./answer-file-resolution.js";

const MiB = 1024 * 1024;
const auth = { familyId: "family-1", role: "owner" } as WorkspaceAuthorization;

function resolverFor(file: { bytes?: Buffer; mediaType: string; path?: string }, size: { height: number; width: number } | null = null) {
  const bytes = file.bytes ?? Buffer.from("bytes");
  const readBinary = vi.fn(async (_auth: unknown, scope: "family" | "group" | "personal", path: string) => ({
    bytes,
    file: {
      byteSize: bytes.byteLength,
      contentSha256: "sha-1",
      mediaType: file.mediaType,
      path: file.path ?? path,
      scope,
      updatedAt: "2026-10-28T00:00:00.000Z",
    },
    workspaceId: "workspace-1",
  }));
  const statBinary = vi.fn(async (_auth: unknown, _scope: unknown, path: string) => ({
    byteSize: bytes.byteLength,
    path: file.path ?? path,
    updatedAt: new Date("2026-10-28T00:00:00.000Z"),
  }));
  const imageSize = vi.fn(async () => size);
  return { imageSize, readBinary, resolver: createAnswerFileResolver({ imageSize, readBinary, statBinary }), statBinary };
}

function refusing(code: string) {
  const refuse = vi.fn(async () => { throw new AppError(code, "workspace refusal"); });
  return createAnswerFileResolver({ imageSize: vi.fn(), readBinary: refuse, statBinary: refuse });
}

const reference = { caption: "", path: "recipes/duchesse.jpg", range: { end: 1, start: 0 }, scope: "personal" as const };

describe("answer file measurement", () => {
  it("measures a file with the chat's rights without reading it", async () => {
    const { readBinary, resolver, statBinary } = resolverFor({ mediaType: "image/jpeg" });

    expect(await resolver.measure(auth, reference)).toEqual({
      file: { byteSize: 5, fileName: "duchesse.jpg", path: "recipes/duchesse.jpg", scope: "personal" },
      ok: true,
    });
    expect(statBinary).toHaveBeenCalledWith(auth, "personal", "recipes/duchesse.jpg");
    expect(readBinary).not.toHaveBeenCalled();
  });

  it("refuses a file over the answer limit without reading it", async () => {
    const { readBinary, resolver } = resolverFor({ bytes: Buffer.alloc(48 * MiB), mediaType: "application/zip" });

    expect(await resolver.measure(auth, reference)).toEqual({ ok: false, problem: "too_large" });
    expect(readBinary).not.toHaveBeenCalled();
  });

  it.each([
    ["AGENT_WORKSPACE_FILE_NOT_FOUND", "not_found"],
    ["AGENT_WORKSPACE_ACCESS_DENIED", "forbidden"],
    ["AGENT_WORKSPACE_ACCESS_REVOKED", "forbidden"],
    ["AGENT_WORKSPACE_PATH_INVALID", "invalid_path"],
    ["AGENT_WORKSPACE_FILE_TOO_LARGE", "too_large"],
  ])("turns %s into the problem %s", async (code, problem) => {
    const resolver = refusing(code);

    expect(await resolver.measure(auth, reference)).toEqual({ ok: false, problem });
    expect(await resolver.load(auth, reference)).toEqual({ ok: false, problem });
  });

  it("refuses every file where the chat has no workspace at all", async () => {
    const { resolver, statBinary } = resolverFor({ mediaType: "image/jpeg" });

    expect(await resolver.measure(null, reference)).toEqual({ ok: false, problem: "forbidden" });
    expect(await resolver.load(null, reference)).toEqual({ ok: false, problem: "forbidden" });
    expect(statBinary).not.toHaveBeenCalled();
  });

  it("lets an unexpected failure through", async () => {
    const outage = vi.fn(async () => { throw new Error("database unavailable"); });
    const resolver = createAnswerFileResolver({ imageSize: vi.fn(), readBinary: outage, statBinary: outage });

    await expect(resolver.measure(auth, reference)).rejects.toThrow("database unavailable");
    await expect(resolver.load(auth, reference)).rejects.toThrow("database unavailable");
  });
});

describe("answer file loading", () => {
  it("sends a picture within Telegram's photo limits as a photo", async () => {
    const { readBinary, resolver } = resolverFor({ mediaType: "image/jpeg" }, { height: 720, width: 1280 });

    const loaded = await resolver.load(auth, reference);

    expect(readBinary).toHaveBeenCalledWith(auth, "personal", "recipes/duchesse.jpg");
    expect(loaded).toEqual({
      file: expect.objectContaining({ fileName: "duchesse.jpg", kind: "photo", mediaType: "image/jpeg", scope: "personal", sha256: "sha-1" }),
      ok: true,
    });
  });

  it.each([
    ["sides over 10000 together", { mediaType: "image/png" }, { height: 1200, width: 9000 }],
    ["one side over twenty times the other", { mediaType: "image/webp" }, { height: 100, width: 2100 }],
    ["a size Telegram cannot read", { mediaType: "image/jpeg" }, null],
    ["over 10 MiB", { bytes: Buffer.alloc(10 * MiB + 1), mediaType: "image/jpeg" }, { height: 720, width: 1280 }],
  ])("sends a picture with %s as a document", async (_case, file, size) => {
    const { resolver } = resolverFor(file, size);

    expect(await resolver.load(auth, reference)).toEqual({ file: expect.objectContaining({ kind: "document" }), ok: true });
  });

  it.each([
    ["video/mp4", "video"],
    ["audio/mpeg", "audio"],
    ["image/gif", "document"],
    ["video/quicktime", "document"],
    ["application/pdf", "document"],
  ])("shows %s as %s", async (mediaType, kind) => {
    const { imageSize, resolver } = resolverFor({ mediaType });

    expect(await resolver.load(auth, reference)).toEqual({ file: expect.objectContaining({ kind }), ok: true });
    expect(imageSize).not.toHaveBeenCalled();
  });

  it("refuses a file that grew over the answer limit since it was measured", async () => {
    const { resolver } = resolverFor({ bytes: Buffer.alloc(48 * MiB), mediaType: "application/zip" });

    expect(await resolver.load(auth, reference)).toEqual({ ok: false, problem: "too_large" });
  });
});

describe("files one answer may carry", () => {
  function file(path: string, byteSize: number): MeasuredAnswerFile {
    return { byteSize, fileName: path, path, scope: "personal" };
  }

  it("admits files in order until 50 files or 47 MiB together", () => {
    const many = Array.from({ length: 51 }, (_, index) => file(`f${index}.pdf`, 1));
    expect(admitAnswerFiles(many).map((admitted) => admitted !== null)).toEqual([...Array(50).fill(true), false]);

    const heavy = [file("a.pdf", 30 * MiB), file("b.pdf", 30 * MiB), file("c.pdf", 10 * MiB)];
    expect(admitAnswerFiles(heavy).map((admitted) => admitted?.path ?? null)).toEqual(["a.pdf", null, "c.pdf"]);
  });

  it("counts a file used twice once", () => {
    const twice = [file("a.pdf", 30 * MiB), file("a.pdf", 30 * MiB)];

    expect(admitAnswerFiles(twice).map((admitted) => admitted?.path ?? null)).toEqual(["a.pdf", "a.pdf"]);
  });
});
