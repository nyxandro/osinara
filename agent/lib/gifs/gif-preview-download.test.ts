/**
 * GIF preview download tests.
 *
 * Constructs covered:
 * - Only KLIPY's media host is fetched, without following redirects.
 * - A preview arrives as exact bytes; a failed, unreachable or oversized one gets its own code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GIF_PREVIEW_MAX_BYTES } from "./gif-reply-config.js";
import { downloadGifPreview } from "./gif-preview-download.js";

const PREVIEW_URL = "https://static.klipy.com/ii/abc/sm.webp";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GIF preview download", () => {
  it("returns the exact preview bytes without following redirects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    await expect(downloadGifPreview(PREVIEW_URL, undefined, fetchMock)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });

  it("never fetches a host outside KLIPY", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(downloadGifPreview("https://internal.example/sm.webp", undefined, fetchMock))
      .rejects.toMatchObject({ code: "AGENT_GIF_PREVIEW_HOST_FORBIDDEN" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names a refused and an unreachable preview", async () => {
    await expect(downloadGifPreview(PREVIEW_URL, undefined, vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 }))))
      .rejects.toMatchObject({ code: "AGENT_GIF_PREVIEW_DOWNLOAD_FAILED" });
    await expect(downloadGifPreview(PREVIEW_URL, undefined, vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"))))
      .rejects.toMatchObject({ code: "AGENT_GIF_PREVIEW_DOWNLOAD_FAILED" });
  });

  it("stops reading a preview above the size limit even without a declared length", async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(GIF_PREVIEW_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });

    await expect(downloadGifPreview(PREVIEW_URL, undefined, vi.fn<typeof fetch>().mockResolvedValue(new Response(oversized))))
      .rejects.toMatchObject({ code: "AGENT_GIF_PREVIEW_TOO_LARGE" });
  });
});
