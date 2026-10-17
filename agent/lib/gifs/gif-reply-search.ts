/**
 * Search for one fitting GIF: KLIPY results shown to the vision model sheet by sheet.
 *
 * Exports:
 * - `GifReplySearchResult`: a picked GIF with what it shows, or why there is none.
 * - `createGifReplySearch`: one search request, then up to three numbered sheets of six.
 *
 * Key constructs:
 * - Sheets follow KLIPY's order; the vision model only says which shown cell fits, if any.
 * - A preview that cannot be downloaded or read is left off its sheet and reported: the other
 *   candidates still deserve a look. A sheet left without any preview means the media host is
 *   failing, and the search fails instead of paging through the same failure.
 */
import { AppError, isAppError } from "../app-error.js";
import {
  GIF_CONTACT_SHEET_SIZE,
  GIF_CONTACT_SHEETS_MAX,
  GIF_SEARCH_RESULTS,
  type KlipyContentFilter,
} from "./gif-reply-config.js";
import type { GifPick } from "./gif-picker.js";
import type { KlipyGif, KlipySearchInput } from "./klipy-client.js";

export type GifReplySearchResult =
  | { description: string; gif: KlipyGif; outcome: "picked"; sheetsShown: number }
  | { outcome: "no_results" }
  | { outcome: "no_suitable_gif"; sheetsShown: number };

interface GifReplySearchDependencies {
  composeSheet(frames: readonly Uint8Array[]): Promise<Uint8Array>;
  downloadPreview(url: string, abortSignal?: AbortSignal): Promise<Uint8Array>;
  pick(input: { abortSignal?: AbortSignal; brief: string; count: number; sheet: Uint8Array }): Promise<GifPick>;
  previewFrame(preview: Uint8Array): Promise<Uint8Array>;
  search(input: KlipySearchInput): Promise<KlipyGif[]>;
}

export function createGifReplySearch(dependencies: GifReplySearchDependencies) {
  async function shownCandidate(gif: KlipyGif, abortSignal?: AbortSignal) {
    try {
      return { frame: await dependencies.previewFrame(await dependencies.downloadPreview(gif.previewUrl, abortSignal)), gif };
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_GIF_PREVIEW_SKIPPED",
        errorCode: isAppError(error) ? error.code : undefined,
        errorName: error instanceof Error ? error.name : "UnknownError",
        slug: gif.slug,
      }));
      return null;
    }
  }

  return async function findGifReply(input: {
    abortSignal?: AbortSignal;
    brief: string;
    contentFilter: KlipyContentFilter;
    query: string;
  }): Promise<GifReplySearchResult> {
    const results = await dependencies.search({
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      contentFilter: input.contentFilter,
      perPage: GIF_SEARCH_RESULTS,
      query: input.query,
    });
    if (results.length === 0) return { outcome: "no_results" };

    let sheetsShown = 0;
    while (sheetsShown < GIF_CONTACT_SHEETS_MAX) {
      const start = sheetsShown * GIF_CONTACT_SHEET_SIZE;
      const candidates = results.slice(start, start + GIF_CONTACT_SHEET_SIZE);
      if (candidates.length === 0) break;
      const shown = (await Promise.all(candidates.map(async (gif) => await shownCandidate(gif, input.abortSignal))))
        .filter((candidate) => candidate !== null);
      if (shown.length === 0) {
        throw new AppError("AGENT_GIF_PREVIEWS_UNAVAILABLE", "Не удалось загрузить ни одного превью гифок");
      }
      const pick = await dependencies.pick({
        ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
        brief: input.brief,
        count: shown.length,
        sheet: await dependencies.composeSheet(shown.map(({ frame }) => frame)),
      });
      sheetsShown += 1;
      if (pick.choice !== null) {
        return { description: pick.description, gif: shown[pick.choice - 1]!.gif, outcome: "picked", sheetsShown };
      }
    }
    return { outcome: "no_suitable_gif", sheetsShown };
  };
}

export type FindGifReply = ReturnType<typeof createGifReplySearch>;
