/**
 * KLIPY GIF search client.
 *
 * Exports:
 * - `KlipyGif`: one search result reduced to what a reply uses.
 * - `KlipySearchInput`: query, page size and content filter of one search.
 * - `createKlipyClient`: searches GIFs; the key travels in the URL path and never reaches a log.
 *
 * Key constructs:
 * - The response envelope is validated strictly and a broken one fails the whole search.
 * - An item that is not a GIF (an ad, should the partner panel ever enable them), lacks a needed
 *   format or points outside KLIPY's media host is skipped and reported once: one bad result must
 *   not cost the whole search, and a foreign host must never be fetched by the backend.
 */
import { z } from "zod";

import { AppError } from "../app-error.js";
import {
  KLIPY_API_BASE_URL,
  KLIPY_MEDIA_HOSTS,
  KLIPY_REQUEST_TIMEOUT_MS,
  type KlipyContentFilter,
} from "./gif-reply-config.js";

export interface KlipyGif {
  height: number;
  /** Small animated WebP the contact sheet takes a frame from. */
  previewUrl: string;
  /** MP4 Telegram downloads itself and shows as an animation. */
  sendUrl: string;
  slug: string;
  title: string;
  width: number;
}

export interface KlipySearchInput {
  abortSignal?: AbortSignal;
  contentFilter: KlipyContentFilter;
  perPage: number;
  query: string;
}

// Only the WebP preview and the MP4 for sending are used, so the response carries nothing else.
const FORMAT_FILTER = "webp,mp4";

const envelopeSchema = z.object({
  data: z.object({ data: z.array(z.unknown()) }),
  result: z.literal(true),
});

const mediaSchema = z.object({
  height: z.number().int().positive(),
  url: z.url({ protocol: /^https$/u }),
  width: z.number().int().positive(),
});

const gifSchema = z.object({
  file: z.object({
    hd: z.object({ mp4: mediaSchema }),
    sm: z.object({ webp: mediaSchema }),
  }),
  slug: z.string().min(1),
  title: z.string(),
  type: z.literal("gif"),
});

function isKlipyMedia(url: string): boolean {
  return KLIPY_MEDIA_HOSTS.has(new URL(url).hostname);
}

function toKlipyGif(item: unknown): KlipyGif | null {
  const parsed = gifSchema.safeParse(item);
  if (!parsed.success) return null;
  const { file, slug, title } = parsed.data;
  if (!isKlipyMedia(file.sm.webp.url) || !isKlipyMedia(file.hd.mp4.url)) return null;
  return {
    height: file.hd.mp4.height,
    previewUrl: file.sm.webp.url,
    sendUrl: file.hd.mp4.url,
    slug,
    title,
    width: file.hd.mp4.width,
  };
}

const providerErrorSchema = z.object({ errors: z.object({ message: z.array(z.string()) }) });

/** KLIPY explains a refusal in `errors.message`; the key is cut out in case a message ever quotes it. */
async function providerErrorMessage(response: Response, apiKey: string): Promise<string | undefined> {
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return undefined;
  }
  const parsed = providerErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.errors.message.join(" ").replaceAll(apiKey, "[redacted]") : undefined;
}

function providerStatusError(status: number, providerMessage: string | undefined): AppError {
  if (status === 429) {
    return new AppError("AGENT_GIF_SEARCH_RATE_LIMITED", "Лимит поиска гифок исчерпан на ближайший час");
  }
  // KLIPY answers an unknown or revoked key with 404 and an explanation rather than with 401/403.
  const keyRefused = status === 401 || status === 403 ||
    (status === 404 && providerMessage?.includes("API key") === true);
  if (keyRefused) {
    return new AppError("AGENT_GIF_SEARCH_KEY_REJECTED", "Сервис гифок не принял ключ доступа");
  }
  return new AppError("AGENT_GIF_SEARCH_FAILED", "Сервис гифок вернул ошибку");
}

function invalidResponse(): AppError {
  return new AppError("AGENT_GIF_SEARCH_RESPONSE_INVALID", "Сервис гифок вернул ответ в неизвестном формате");
}

export function createKlipyClient(dependencies: { apiKey: string; fetch: typeof fetch }) {
  return {
    async search(input: KlipySearchInput): Promise<KlipyGif[]> {
      const url = new URL(`${KLIPY_API_BASE_URL}/${encodeURIComponent(dependencies.apiKey)}/gifs/search`);
      url.searchParams.set("q", input.query);
      url.searchParams.set("page", "1");
      url.searchParams.set("per_page", String(input.perPage));
      url.searchParams.set("content_filter", input.contentFilter);
      url.searchParams.set("format_filter", FORMAT_FILTER);

      let response: Response;
      try {
        const timeout = AbortSignal.timeout(KLIPY_REQUEST_TIMEOUT_MS);
        response = await dependencies.fetch(url, {
          signal: input.abortSignal === undefined ? timeout : AbortSignal.any([input.abortSignal, timeout]),
        });
      } catch (error) {
        // The error message of a failed fetch may quote the URL, and the URL holds the key.
        console.error(JSON.stringify({
          code: "AGENT_GIF_SEARCH_UNAVAILABLE",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
        throw new AppError("AGENT_GIF_SEARCH_UNAVAILABLE", "Сервис гифок не ответил");
      }
      if (!response.ok) {
        const providerMessage = await providerErrorMessage(response, dependencies.apiKey);
        const failure = providerStatusError(response.status, providerMessage);
        console.error(JSON.stringify({
          code: failure.code,
          ...(providerMessage === undefined ? {} : { providerMessage }),
          providerStatus: response.status,
        }));
        throw failure;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        console.error(JSON.stringify({ code: "AGENT_GIF_SEARCH_RESPONSE_INVALID", reason: "not_json" }));
        throw invalidResponse();
      }
      const envelope = envelopeSchema.safeParse(body);
      if (!envelope.success) {
        console.error(JSON.stringify({ code: "AGENT_GIF_SEARCH_RESPONSE_INVALID", reason: "envelope" }));
        throw invalidResponse();
      }

      const items = envelope.data.data.data;
      const gifs = items.map(toKlipyGif).filter((gif): gif is KlipyGif => gif !== null);
      if (gifs.length < items.length) {
        console.error(JSON.stringify({
          code: "AGENT_GIF_SEARCH_ITEMS_SKIPPED",
          skipped: items.length - gifs.length,
          total: items.length,
        }));
      }
      return gifs;
    },
  };
}

export type KlipyClient = ReturnType<typeof createKlipyClient>;
