/**
 * Behaviour settings of GIF replies.
 *
 * Exports:
 * - `KlipyContentFilter`: the provider's content safety levels.
 * - Search, contact-sheet, download and delivery limits used by one `send_gif` call.
 * - `GIF_CONTENT_FILTER_BY_CHAT`: the owner-agreed safety level of each conversation kind.
 *
 * Only the API key comes from the environment; everything that shapes behaviour lives here.
 */
export type KlipyContentFilter = "high" | "low" | "medium" | "off";

export const KLIPY_API_BASE_URL = "https://api.klipy.com/api/v1";
/** Media is fetched only from KLIPY's own CDN, never from a host a response merely names. */
export const KLIPY_MEDIA_HOSTS: ReadonlySet<string> = new Set(["static.klipy.com"]);
export const KLIPY_REQUEST_TIMEOUT_MS = 10_000;

export const GIF_CONTACT_SHEET_SIZE = 6;
export const GIF_CONTACT_SHEETS_MAX = 3;
/** One search request feeds every contact sheet of a call, so a call costs one API request. */
export const GIF_SEARCH_RESULTS = GIF_CONTACT_SHEET_SIZE * GIF_CONTACT_SHEETS_MAX;

export const GIF_PREVIEW_DOWNLOAD_TIMEOUT_MS = 10_000;
/** KLIPY's small animated WebP previews weigh about 100 KB; anything far larger is not a preview. */
export const GIF_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** Measured 17.10.2026: one look at a sheet takes 12–16 s on the production vision model. */
export const GIF_PICK_TIMEOUT_MS = 40_000;

export const GIF_QUERY_MAX_LENGTH = 100;
export const GIF_BRIEF_MAX_LENGTH = 1_000;
export const GIF_DESCRIPTION_MAX_LENGTH = 200;

/** A family group may include children, so it gets the strictest level KLIPY offers. */
export const GIF_CONTENT_FILTER_BY_CHAT: Readonly<Record<"external" | "family" | "private", KlipyContentFilter>> = {
  external: "medium",
  family: "high",
  private: "medium",
};
