/**
 * KLIPY GIF search client tests.
 *
 * Constructs covered:
 * - The request carries the key in the path, the query, the page size, the content filter and the
 *   two formats a reply needs.
 * - Results keep the provider order and are reduced to a preview, a send URL and a title.
 * - A non-GIF item, an item without a needed format or with a media host outside KLIPY is skipped
 *   and reported once; a broken envelope fails the whole search.
 * - Every provider failure has its own code, and no log line ever contains the key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createKlipyClient } from "./klipy-client.js";

const API_KEY = "test-klipy-key-123";

function gifItem(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    blur_preview: "data:image/jpeg;base64,AAAA",
    file: {
      hd: { mp4: { height: 260, size: 99_786, url: `https://static.klipy.com/ii/${slug}/hd.mp4`, width: 498 } },
      sm: { webp: { height: 115, size: 76_846, url: `https://static.klipy.com/ii/${slug}/sm.webp`, width: 220 } },
    },
    id: 8_041_071_659_142_944,
    slug,
    tags: [],
    title: `Title ${slug}`,
    type: "gif",
    ...overrides,
  };
}

function okResponse(items: readonly unknown[]): Response {
  return new Response(JSON.stringify({
    data: { current_page: 1, data: items, has_next: true, meta: {}, per_page: items.length },
    result: true,
  }), { headers: { "content-type": "application/json" }, status: 200 });
}

function client(fetchImplementation: typeof fetch) {
  return createKlipyClient({
    apiKey: API_KEY,
    fetch: fetchImplementation,
  });
}

const SEARCH = { contentFilter: "medium", perPage: 18, query: "middle finger" } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("KLIPY GIF search", () => {
  it("requests exactly the formats and filter a reply needs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse([gifItem("a")]));

    await client(fetchMock).search(SEARCH);

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(`https://api.klipy.com/api/v1/${API_KEY}/gifs/search`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      content_filter: "medium",
      format_filter: "webp,mp4",
      page: "1",
      per_page: "18",
      q: "middle finger",
    });
  });

  it("keeps the provider order and reduces each GIF to what a reply uses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse([gifItem("first"), gifItem("second")]));

    await expect(client(fetchMock).search(SEARCH)).resolves.toEqual([
      {
        height: 260,
        previewUrl: "https://static.klipy.com/ii/first/sm.webp",
        sendUrl: "https://static.klipy.com/ii/first/hd.mp4",
        slug: "first",
        title: "Title first",
        width: 498,
      },
      {
        height: 260,
        previewUrl: "https://static.klipy.com/ii/second/sm.webp",
        sendUrl: "https://static.klipy.com/ii/second/hd.mp4",
        slug: "second",
        title: "Title second",
        width: 498,
      },
    ]);
  });

  it("skips unusable items and reports them once without the key", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse([
      gifItem("advert", { type: "ad" }),
      gifItem("no-preview", { file: { hd: gifItem("x").file.hd } }),
      gifItem("foreign", {
        file: { ...gifItem("x").file, sm: { webp: { height: 1, size: 1, url: "https://evil.example/sm.webp", width: 1 } } },
      }),
      gifItem("kept"),
    ]));

    const gifs = await client(fetchMock).search(SEARCH);

    expect(gifs.map(({ slug }) => slug)).toEqual(["kept"]);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({ code: "AGENT_GIF_SEARCH_ITEMS_SKIPPED", skipped: 3, total: 4 });
    expect(line).not.toContain(API_KEY);
  });

  it("returns an empty list when nothing matched", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse([]));

    await expect(client(fetchMock).search(SEARCH)).resolves.toEqual([]);
  });

  it.each([
    [429, "{}", "AGENT_GIF_SEARCH_RATE_LIMITED"],
    [401, "{}", "AGENT_GIF_SEARCH_KEY_REJECTED"],
    [403, "{}", "AGENT_GIF_SEARCH_KEY_REJECTED"],
    [404, "{}", "AGENT_GIF_SEARCH_FAILED"],
    [500, "{}", "AGENT_GIF_SEARCH_FAILED"],
  ])("names a provider status %i as %s", async (status, body, code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));

    await expect(client(fetchMock).search(SEARCH)).rejects.toMatchObject({ code });
    expect(log.mock.calls.flat().join(" ")).not.toContain(API_KEY);
  });

  it("recognizes KLIPY's own answer to an invalid key and logs its reason without the key", async () => {
    // Observed 17.10.2026: KLIPY answers an unknown key with 404 and this body, not with 401/403.
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      errors: { message: [`The provided API key is invalid. (${API_KEY})`] },
      result: false,
    }), { status: 404 }));

    await expect(client(fetchMock).search(SEARCH)).rejects.toMatchObject({ code: "AGENT_GIF_SEARCH_KEY_REJECTED" });
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
      code: "AGENT_GIF_SEARCH_KEY_REJECTED",
      providerMessage: "The provided API key is invalid. ([redacted])",
      providerStatus: 404,
    });
  });

  it("names an unreachable provider without leaking the request URL", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError(`fetch failed for https://api.klipy.com/api/v1/${API_KEY}/gifs/search`),
    );

    await expect(client(fetchMock).search(SEARCH)).rejects.toMatchObject({ code: "AGENT_GIF_SEARCH_UNAVAILABLE" });
    expect(log.mock.calls.flat().join(" ")).not.toContain(API_KEY);
  });

  it.each([
    ["a broken envelope", JSON.stringify({ data: { data: "nope" }, result: true })],
    ["a refused result", JSON.stringify({ data: { data: [] }, result: false })],
    ["a non-JSON body", "<html>"],
  ])("fails the whole search on %s", async (_label, body) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));

    await expect(client(fetchMock).search(SEARCH)).rejects.toMatchObject({ code: "AGENT_GIF_SEARCH_RESPONSE_INVALID" });
  });
});
