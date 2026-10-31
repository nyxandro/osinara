/**
 * Telegram avatar source tests.
 *
 * Constructs covered:
 * - `createTelegramAvatarSource`: asks Telegram for the current photo only, takes the largest size up
 *   to 640 px, reads "no photo", a hidden photo and "user not found" as no avatar, and refuses a
 *   failed or malformed answer and bytes that are not a JPEG.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramAvatarSource } from "./telegram-avatar-source.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function photos(sizes: Array<[number, number]>) {
  return {
    body: {
      ok: true,
      result: {
        photos: [sizes.map(([width, size], index) => ({
          file_id: `file-${width}`,
          file_size: size,
          file_unique_id: `unique-${index}`,
          height: width,
          width,
        }))],
        total_count: 3,
      },
    },
    ok: true,
    status: 200,
  };
}

describe("createTelegramAvatarSource", () => {
  it("asks for the current photo only and takes the largest size up to 640 px", async () => {
    const profilePhotos = vi.fn().mockResolvedValue(photos([[160, 8_000], [320, 25_000], [640, 76_000], [1280, 300_000]]));
    const source = createTelegramAvatarSource({ download: vi.fn(), profilePhotos });

    await expect(source.lookup("101")).resolves.toEqual({
      photo: { fileId: "file-640", fileUniqueId: "unique-2", height: 640, size: 76_000, width: 640 },
      status: "photo",
    });
    expect(profilePhotos).toHaveBeenCalledWith("101");
  });

  it("reads an empty photo list as no avatar: no photo and a hidden one look the same to a bot", async () => {
    const source = createTelegramAvatarSource({
      download: vi.fn(),
      profilePhotos: vi.fn().mockResolvedValue({ body: { ok: true, result: { photos: [], total_count: 0 } }, ok: true, status: 200 }),
    });

    await expect(source.lookup("101")).resolves.toEqual({ status: "none" });
  });

  it("reads Telegram's «user not found» for a person who writes in the chat as no avatar", async () => {
    const source = createTelegramAvatarSource({
      download: vi.fn(),
      profilePhotos: vi.fn().mockResolvedValue({
        body: { description: "Bad Request: user not found", error_code: 400, ok: false },
        ok: false,
        status: 400,
      }),
    });

    await expect(source.lookup("101")).resolves.toEqual({ status: "none" });
  });

  it("refuses any other failed answer with a code the model can act on", async () => {
    const source = createTelegramAvatarSource({
      download: vi.fn(),
      profilePhotos: vi.fn().mockResolvedValue({
        body: { description: "Too Many Requests: retry after 5", error_code: 429, ok: false },
        ok: false,
        status: 429,
      }),
    });

    await expect(source.lookup("101")).rejects.toMatchObject({
      contract: { code: "AGENT_TELEGRAM_AVATAR_LOOKUP_FAILED", retryable: false, sideEffectStatus: "not_started" },
    });
  });

  it("refuses a transport failure the same way", async () => {
    const source = createTelegramAvatarSource({
      download: vi.fn(),
      profilePhotos: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    });

    await expect(source.lookup("101")).rejects.toMatchObject({ contract: { code: "AGENT_TELEGRAM_AVATAR_LOOKUP_FAILED" } });
  });

  it("refuses a malformed answer instead of guessing a photo", async () => {
    const source = createTelegramAvatarSource({
      download: vi.fn(),
      profilePhotos: vi.fn().mockResolvedValue({ body: { ok: true, result: { photos: "none" } }, ok: true, status: 200 }),
    });

    await expect(source.lookup("101")).rejects.toThrowError(/AGENT_TELEGRAM_AVATAR_RESPONSE_INVALID/);
  });

  it("downloads the chosen size as a Telegram photo and accepts only JPEG bytes", async () => {
    const download = vi.fn().mockResolvedValueOnce(JPEG).mockResolvedValueOnce(Buffer.from("<html>"));
    const source = createTelegramAvatarSource({ download, profilePhotos: vi.fn() });
    const photo = { fileId: "file-640", fileUniqueId: "unique-2", height: 640, size: 76_000, width: 640 };

    await expect(source.download(photo)).resolves.toEqual(JPEG);
    expect(download).toHaveBeenCalledWith({
      fileId: "file-640",
      fileUniqueId: "unique-2",
      height: 640,
      kind: "photo",
      mediaType: "image/jpeg",
      size: 76_000,
      width: 640,
    });
    await expect(source.download(photo)).rejects.toThrowError(/AGENT_TELEGRAM_AVATAR_RESPONSE_INVALID/);
  });
});
