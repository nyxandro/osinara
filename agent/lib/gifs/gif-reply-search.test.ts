/**
 * GIF reply search tests.
 *
 * Constructs covered:
 * - One search request feeds every sheet; an empty result never reaches the vision model.
 * - Sheets hold six results in provider order, a short result fits one sheet, and paging stops
 *   after the third sheet.
 * - A preview that fails is left off its sheet, numbers follow the shown cells, and a sheet with no
 *   preview at all fails the search.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GifPick } from "./gif-picker.js";
import type { KlipyGif } from "./klipy-client.js";
import { createGifReplySearch } from "./gif-reply-search.js";

function gif(index: number): KlipyGif {
  return {
    height: 100,
    previewUrl: `https://static.klipy.com/preview-${index}.webp`,
    sendUrl: `https://static.klipy.com/send-${index}.mp4`,
    slug: `gif-${index}`,
    title: `GIF ${index}`,
    width: 100,
  };
}

function setup(options: { failingPreviews?: readonly number[]; picks: readonly GifPick[]; results: number }) {
  const results = Array.from({ length: options.results }, (_, index) => gif(index + 1));
  const search = vi.fn().mockResolvedValue(results);
  const downloadPreview = vi.fn(async (url: string) => {
    const index = Number(/preview-(\d+)/u.exec(url)![1]);
    if (options.failingPreviews?.includes(index)) throw new Error(`preview ${index} unavailable`);
    return new TextEncoder().encode(url);
  });
  const previewFrame = vi.fn(async (bytes: Uint8Array) => Buffer.from(new TextDecoder().decode(bytes)));
  const composeSheet = vi.fn(async (_frames: readonly Uint8Array[]) => new Uint8Array([0xff, 0xd8]));
  const pick = vi.fn();
  for (const answer of options.picks) pick.mockResolvedValueOnce(answer);
  const find = createGifReplySearch({ composeSheet, downloadPreview, pick, previewFrame, search });
  return { composeSheet, find, pick, search };
}

const INPUT = { brief: "съязвить в ответ", contentFilter: "medium", query: "middle finger" } as const;

function shownPreviews(frames: readonly Uint8Array[]): number[] {
  return frames.map((frame) => Number(/preview-(\d+)/u.exec(new TextDecoder().decode(frame))![1]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GIF reply search", () => {
  it("asks for all sheets in one request and stops on an empty result", async () => {
    const { find, pick, search } = setup({ picks: [], results: 0 });

    await expect(find(INPUT)).resolves.toEqual({ outcome: "no_results" });
    expect(search).toHaveBeenCalledExactlyOnceWith({ contentFilter: "medium", perPage: 18, query: "middle finger" });
    expect(pick).not.toHaveBeenCalled();
  });

  it("picks from the first six results in provider order", async () => {
    const { composeSheet, find, pick } = setup({
      picks: [{ choice: 2, description: "робот показывает средний палец" }],
      results: 18,
    });

    await expect(find(INPUT)).resolves.toEqual({
      description: "робот показывает средний палец",
      gif: gif(2),
      outcome: "picked",
      sheetsShown: 1,
    });
    expect(shownPreviews(composeSheet.mock.calls[0]![0])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ brief: "съязвить в ответ", count: 6 }));
  });

  it("shows the next six when nothing on a sheet fits", async () => {
    const { composeSheet, find } = setup({
      picks: [{ choice: null }, { choice: 3, description: "кот закатывает глаза" }],
      results: 18,
    });

    await expect(find(INPUT)).resolves.toMatchObject({ gif: gif(9), outcome: "picked", sheetsShown: 2 });
    expect(shownPreviews(composeSheet.mock.calls[1]![0])).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it("gives up after the third sheet", async () => {
    const { find, pick } = setup({ picks: [{ choice: null }, { choice: null }, { choice: null }], results: 18 });

    await expect(find(INPUT)).resolves.toEqual({ outcome: "no_suitable_gif", sheetsShown: 3 });
    expect(pick).toHaveBeenCalledTimes(3);
  });

  it("puts a short result on one sheet and does not page past it", async () => {
    const { composeSheet, find, pick } = setup({ picks: [{ choice: null }], results: 4 });

    await expect(find(INPUT)).resolves.toEqual({ outcome: "no_suitable_gif", sheetsShown: 1 });
    expect(shownPreviews(composeSheet.mock.calls[0]![0])).toEqual([1, 2, 3, 4]);
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ count: 4 }));
  });

  it("leaves a failed preview off the sheet and numbers the cells that are shown", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { composeSheet, find } = setup({
      failingPreviews: [2],
      picks: [{ choice: 2, description: "третья гифка" }],
      results: 6,
    });

    await expect(find(INPUT)).resolves.toMatchObject({ gif: gif(3), outcome: "picked" });
    expect(shownPreviews(composeSheet.mock.calls[0]![0])).toEqual([1, 3, 4, 5, 6]);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
      code: "AGENT_GIF_PREVIEW_SKIPPED",
      errorName: "Error",
      slug: "gif-2",
    });
  });

  it("fails when no preview of a sheet can be shown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { find, pick } = setup({ failingPreviews: [1, 2], picks: [], results: 2 });

    await expect(find(INPUT)).rejects.toMatchObject({ code: "AGENT_GIF_PREVIEWS_UNAVAILABLE" });
    expect(pick).not.toHaveBeenCalled();
  });
});
