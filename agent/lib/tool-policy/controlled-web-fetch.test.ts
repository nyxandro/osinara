/**
 * Controlled external-group web fetch tests.
 *
 * Constructs covered:
 * - `createControlledWebFetch`: injectable proxied HTTP executor with strict URL and resource limits;
 *   a refusing site's status reaches the model, its origin only the diagnostics.
 * - `controlledWebFetchTool`: custom `web_fetch` definition with the built-in input contract.
 * - A page longer than one portion is read on by `offset`: every portion starts where the previous
 *   one ended, and all of them together are the whole page text.
 * - A name the egress proxy found no address for is told to the model as a mistyped address, not as
 *   an outage to try again later.
 */
import { Buffer } from "node:buffer";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

import fc from "fast-check";
import { fetch as undiciFetch, ProxyAgent, type RequestInit, type Response } from "undici";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import {
  CONTROLLED_WEB_FETCH_MAX_BODY_BYTES,
  CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES,
  CONTROLLED_WEB_FETCH_MAX_MODEL_LINES,
  CONTROLLED_WEB_FETCH_PROXY_URL,
  CONTROLLED_WEB_FETCH_INPUT_SCHEMA,
  createControlledWebFetch,
  controlledWebFetchTool,
} from "./controlled-web-fetch.js";

type FetchCall = [URL | string, RequestInit | undefined];

// A lone surrogate does not survive a UTF-8 round trip: it comes back as U+FFFD.
function wellFormed(text: string): boolean {
  return Buffer.from(text, "utf8").toString("utf8") === text;
}

function response(body: BodyInit | null, init?: ResponseInit): Response {
  return new globalThis.Response(body, init) as unknown as Response;
}

describe("controlled external-group web fetch", () => {
  it("preserves the built-in input contract and always dispatches through the fixed proxy", async () => {
    const fetch = vi.fn(async () => response("<h1>Hello</h1>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    const dispatcher = new ProxyAgent(CONTROLLED_WEB_FETCH_PROXY_URL);
    const execute = createControlledWebFetch({ dispatcher, fetch });

    const result = await execute({
      format: "extracted_text",
      timeout: 12,
      url: "https://example.com/page",
    });

    expect(CONTROLLED_WEB_FETCH_INPUT_SCHEMA.safeParse({
      format: "extracted_text",
      timeout: 120,
      url: "https://example.com",
    }).success).toBe(true);
    expect(CONTROLLED_WEB_FETCH_INPUT_SCHEMA.safeParse({
      format: "markdown",
      url: "https://example.com",
    }).success).toBe(false);
    expect(controlledWebFetchTool.execute).toBeTypeOf("function");
    expect(result.content).toBe("Hello");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as FetchCall;
    expect(init).toMatchObject({ dispatcher, redirect: "manual" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    await dispatcher.close();
  });

  it.each([
    ["unsupported protocol", "ftp://example.com/file"],
    ["embedded username", "https://user@example.com/file"],
    ["embedded password", "https://user:secret@example.com/file"],
    ["non-default port", "https://example.com:8443/file"],
  ])("rejects %s before dispatch", async (_label, url) => {
    const fetch = vi.fn();
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url })).rejects.toThrowError(/AGENT_WEB_FETCH_URL_FORBIDDEN/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://example.com",
    "http://example.com:80/path",
    "https://example.com",
    "https://example.com:443/path",
  ])("accepts default HTTP(S) endpoint %s", async (url) => {
    const fetch = vi.fn(async () => response("ok"));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url })).resolves.toMatchObject({ content: "ok" });
  });

  it("follows at most five redirects manually and validates every destination", async () => {
    const fetch = vi.fn(async (input: URL | string) => {
      const current = new URL(input);
      const hop = Number(current.pathname.slice(1) || "0");
      return response(null, { headers: { location: `https://example.com/${hop + 1}` }, status: 302 });
    });
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url: "https://example.com/0" })).rejects.toThrowError(
      /AGENT_WEB_FETCH_REDIRECT_LIMIT/,
    );
    expect(fetch).toHaveBeenCalledTimes(6);
    for (const [, init] of fetch.mock.calls as unknown as FetchCall[]) {
      expect(init?.redirect).toBe("manual");
      expect(init?.dispatcher).toBeDefined();
    }
  });

  it("rejects a forbidden redirect target before another request", async () => {
    const fetch = vi.fn(async () => response(null, {
      headers: { location: "http://user@example.com/private" },
      status: 302,
    }));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url: "https://example.com" })).rejects.toThrowError(
      /AGENT_WEB_FETCH_URL_FORBIDDEN/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops streaming once the five MiB response limit is exceeded", async () => {
    const oversized = new Uint8Array(CONTROLLED_WEB_FETCH_MAX_BODY_BYTES + 1);
    const fetch = vi.fn(async () => response(oversized, {
      headers: { "content-type": "text/plain" },
    }));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url: "https://example.com/large" })).rejects.toThrowError(
      /AGENT_WEB_FETCH_BODY_TOO_LARGE/,
    );
  });

  it.each([
    ["binary content", { "content-type": "application/octet-stream" }],
    ["missing content type", {}],
    ["malformed content type", { "content-type": "not a media type" }],
  ])("rejects %s before reading it as model text", async (_label, headers) => {
    const fetch = vi.fn(async () => response(new Uint8Array([0, 1, 2, 3]), { headers }));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url: "https://example.com/file" })).rejects.toThrowError(
      /AGENT_WEB_FETCH_CONTENT_TYPE_UNSUPPORTED/,
    );
  });

  it.each(["text/plain", "application/json", "application/problem+json", "application/xml"])(
    "accepts model-readable structured content type %s",
    async (contentType) => {
      const fetch = vi.fn(async () => response("structured text", {
        headers: { "content-type": contentType },
      }));
      const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

      await expect(execute({ url: "https://example.com/data" })).resolves.toMatchObject({
        content: "structured text",
        contentType,
      });
    },
  );

  it("bounds textual model content by UTF-8 bytes without splitting a code point", async () => {
    const fetch = vi.fn(async () => response("я".repeat(CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES)));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    const result = await execute({ format: "extracted_text", url: "https://example.com/text" });

    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(
      CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES,
    );
    expect(result.content).not.toContain("�");
    expect(result.truncated).toBe(true);
    expect(await controlledWebFetchTool.toModelOutput?.(result)).toEqual({
      type: "json",
      value: {
        content: result.content,
        contentType: "text/plain",
        finalUrl: "https://example.com/text",
        nextOffset: result.content.length,
        offset: 0,
        totalCharacters: CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES,
        truncated: true,
      },
    });
  });

  it("returns raw HTML only when requested and otherwise labels extraction as plain text", async () => {
    const fetch = vi.fn(async () => response("<article><h1>Title</h1><p>Body</p></article>", {
      headers: { "content-type": "text/html" },
    }));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ format: "extracted_text", url: "https://example.com/article" }))
      .resolves.toMatchObject({ content: "Title\nBody", finalUrl: "https://example.com/article" });
    await expect(execute({ format: "html", url: "https://example.com/article" }))
      .resolves.toMatchObject({
        content: "<article><h1>Title</h1><p>Body</p></article>",
        finalUrl: "https://example.com/article",
      });
  });

  it("reads a page whose character reference names no character, showing the replacement mark there", async () => {
    const page = "<p>a&#99999999;b &#x110000; &#0; &#xD800; &#171;c&#187;</p>";
    const execute = createControlledWebFetch({
      dispatcher: {} as never,
      fetch: async () => response(page, { headers: { "content-type": "text/html" } }),
    });

    await expect(execute({ url: "https://example.com/broken" }))
      .resolves.toMatchObject({ content: "a�b � � � «c»" });
  });

  it("turns every numeric character reference into the character it names, or the replacement mark", async () => {
    // What a page can carry: any digits in decimal or hex, leading zeros, far past U+10FFFF.
    // Controls and spaces are left out: the extraction strips or collapses them after decoding.
    const codePoint = fc.oneof(
      fc.integer({ max: 0x7e, min: 0x21 }),
      fc.integer({ max: 0x10ffff, min: 0x80 }),
      fc.integer({ max: 0xdfff, min: 0xd800 }),
      fc.constant(0),
      fc.bigInt({ max: 10n ** 400n, min: 0x110000n }),
    ).map((value) => BigInt(value));
    const reference = fc.tuple(codePoint, fc.boolean(), fc.boolean(), fc.nat({ max: 3 }))
      .map(([value, hex, upper, zeros]) => {
        const digits = "0".repeat(zeros) + (hex ? value.toString(16) : value.toString(10));
        return { text: hex ? `&#${upper ? "X" : "x"}${upper ? digits.toUpperCase() : digits};` : `&#${digits};`, value };
      });
    const named = (value: bigint) => value > 0n && value <= 0x10ffffn && !(value >= 0xd800n && value <= 0xdfffn)
      ? String.fromCodePoint(Number(value))
      : "�";

    await fc.assert(fc.asyncProperty(reference, async ({ text, value }) => {
      const execute = createControlledWebFetch({
        dispatcher: {} as never,
        fetch: async () => response(`<p>x${text}y</p>`, { headers: { "content-type": "text/html" } }),
      });
      const result = await execute({ url: "https://example.com/reference" });
      expect(wellFormed(result.content)).toBe(true);
      expect(result.content).toBe(`x${named(value)}y`);
    }), {
      examples: [
        [{ text: "&#99999999;", value: 99_999_999n }],
        [{ text: "&#0;", value: 0n }],
        [{ text: "&#xD800;", value: 0xd800n }],
        [{ text: "&#x10FFFF;", value: 0x10ffffn }],
        [{ text: "&#x110000;", value: 0x110000n }],
      ],
    });
  });

  it("bounds textual model content by line count", async () => {
    const fetch = vi.fn(async () => response(
      "line\n".repeat(CONTROLLED_WEB_FETCH_MAX_MODEL_LINES + 20),
    ));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    const result = await execute({ format: "extracted_text", url: "https://example.com/lines" });

    expect(result.content.split("\n")).toHaveLength(CONTROLLED_WEB_FETCH_MAX_MODEL_LINES);
    expect(result.truncated).toBe(true);
  });

  it("rejects timeout values above the bounded total deadline without dispatch", async () => {
    const fetch = vi.fn();
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ timeout: 121, url: "https://example.com" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tells the model the refusing status and keeps the site only for diagnostics", async () => {
    const fetch = vi.fn(async () => response("denied", { status: 403 }));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    const failure = await execute({ url: "https://news.example.com/2026/09/post?token=secret" })
      .catch((error: unknown) => error);

    // Without the status a blocked site, an invented address and an outage look the same (#302).
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: "AGENT_WEB_FETCH_RESPONSE_FAILED",
      details: { origin: "https://news.example.com", status: 403 },
      isExpectedRefusal: true,
    });
    expect((failure as AppError).message).toContain("HTTP 403");
    expect((failure as AppError).message).not.toContain("example.com");
    expect(JSON.stringify((failure as AppError).details)).not.toContain("secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry failed requests and returns a safe Russian error", async () => {
    // undici reports every network failure as this TypeError, with the reason as its cause.
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
    });
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url: "https://example.com" })).rejects.toThrowError(
      "AGENT_WEB_FETCH_REQUEST_FAILED: Не удалось загрузить страницу через защищённый шлюз. Попробуйте позже",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("records a site the egress proxy could not reach as one line, with the site and the reason", async () => {
    // The egress proxy answers a CONNECT it could not establish with 502 (#499). The tool used to print
    // a 29-line stack for it, which lit UnstructuredProblemBurst on three unreachable sites; a site
    // that does not open is the outside world's answer, not a failure of the application.
    const proxy = createServer((socket) => {
      socket.once("data", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const dispatcher = new ProxyAgent(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
    const execute = createControlledWebFetch({ dispatcher, fetch: undiciFetch });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failure = await execute({ url: "https://incrussia.ru/news?token=secret" }).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "AGENT_WEB_FETCH_REQUEST_FAILED",
        details: { cause: "Proxy response (502) !== 200 when HTTP Tunneling", origin: "https://incrussia.ru" },
        isExpectedRefusal: true,
      });
      expect(JSON.stringify((failure as AppError).details)).not.toContain("secret");
      expect(console.error).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await dispatcher.close();
      await new Promise((done) => proxy.close(done));
    }
  });

  it("keeps its own egress proxy out of reach a failure of the application, not a site's answer", async () => {
    // The agent connects only to the egress proxy; when that connection cannot be opened, no site
    // was even asked, and the failure must stay visible to the alerts (#499).
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise((done) => probe.close(done));
    const dispatcher = new ProxyAgent(`http://127.0.0.1:${closedPort}`);
    const execute = createControlledWebFetch({ dispatcher, fetch: undiciFetch });
    try {
      const failure = await execute({ url: "https://example.com/page" }).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "AGENT_WEB_FETCH_REQUEST_FAILED",
        details: { cause: `connect ECONNREFUSED 127.0.0.1:${closedPort}`, origin: "https://example.com" },
        isExpectedRefusal: false,
      });
    } finally {
      await dispatcher.close();
    }
  });

  it("records a page that stopped arriving as the site's answer", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("terminated", { cause: new Error("other side closed") }));
      },
    });
    const fetch = vi.fn(async () => response(body, { headers: { "content-type": "text/html" } }));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url: "https://news.example.com/long" })).rejects.toMatchObject({
      code: "AGENT_WEB_FETCH_REQUEST_FAILED",
      details: { cause: "other side closed", origin: "https://news.example.com" },
      isExpectedRefusal: true,
    });
  });

  it("lets a defect of its own escape as it is, never as the site's answer", async () => {
    // Only undici's network failures are a site's answer. Anything else thrown while reading a page
    // is a bug of this code: dressed up as "the site did not open" it would be hidden from the alerts.
    const defect = new RangeError("Invalid code point 99999999");
    const fetch = vi.fn(async () => {
      throw defect;
    });
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url: "https://example.com/page" })).rejects.toBe(defect);
  });

  it("records a site that did not answer in time as the outside world's answer", async () => {
    const fetch = vi.fn((_input: URL | string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });
    vi.useFakeTimers();
    try {
      const failure = execute({ timeout: 1, url: "https://slow.example.com/page" }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await failure).toMatchObject({
        code: "AGENT_WEB_FETCH_TIMEOUT",
        details: { origin: "https://slow.example.com" },
        isExpectedRefusal: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a call the turn itself cancelled a cancellation, not the site's answer", async () => {
    const fetch = vi.fn((_input: URL | string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });
    const turn = new AbortController();

    const failure = execute({ url: "https://example.com/page" }, { abortSignal: turn.signal }).catch((error: unknown) => error);
    turn.abort();

    expect(await failure).toMatchObject({ code: "AGENT_WEB_FETCH_CANCELLED", isExpectedRefusal: false });
  });

  it.each([
    ["a redirect loop", "AGENT_WEB_FETCH_REDIRECT_LIMIT", () => response(null, { headers: { location: "https://loop.example.com/again" }, status: 302 })],
    ["a redirect without a target", "AGENT_WEB_FETCH_REDIRECT_INVALID", () => response(null, { status: 302 })],
    ["a page over the size limit", "AGENT_WEB_FETCH_BODY_TOO_LARGE", () => response("x", {
      headers: { "content-length": String(CONTROLLED_WEB_FETCH_MAX_BODY_BYTES + 1), "content-type": "text/plain" },
    })],
    ["a file instead of a page", "AGENT_WEB_FETCH_CONTENT_TYPE_UNSUPPORTED", () => response(new Uint8Array([0, 1]), {
      headers: { "content-type": "application/pdf" },
    })],
  ])("records %s as the site's answer, naming the site", async (_label, code, answer) => {
    const fetch = vi.fn(async () => answer());
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url: "https://loop.example.com/start?token=secret" })).rejects.toMatchObject({
      code,
      details: { origin: "https://loop.example.com" },
      isExpectedRefusal: true,
    });
  });

  it("tells the model an address does not exist when the egress proxy found no host for it", async () => {
    // The proxy's own answer to a CONNECT for a name public DNS does not know; undici keeps only the
    // status of a refused tunnel, so the real ProxyAgent is used here.
    const proxy = createServer((socket) => {
      socket.once("data", () => socket.end("HTTP/1.1 404 Host Not Found\r\nConnection: close\r\n\r\n"));
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const dispatcher = new ProxyAgent(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
    const execute = createControlledWebFetch({ dispatcher, fetch: undiciFetch });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failure = await execute({ url: "https://fivpost.ru/tracking" }).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "AGENT_WEB_FETCH_HOST_NOT_FOUND",
        details: { origin: "https://fivpost.ru" },
        isExpectedRefusal: true,
      });
      expect((failure as AppError).message).toContain("нет IPv4-адреса в публичном DNS");
      expect(console.error).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await dispatcher.close();
      await new Promise((done) => proxy.close(done));
    }
  });

  it("tells the same on a plain HTTP address, where the proxy itself answers instead of a site", async () => {
    const fetch = vi.fn(async () => response("AGENT_SANDBOX_EGRESS_HOST_NOT_FOUND", { status: 404, statusText: "Host Not Found" }));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url: "http://5post.ru/tracking" })).rejects.toMatchObject({
      code: "AGENT_WEB_FETCH_HOST_NOT_FOUND",
      details: { origin: "http://5post.ru" },
    });
  });

  it("keeps a site's own 404 on an HTTPS address a site's answer, whatever its status text", async () => {
    // Through a tunnel the answer comes from the site itself, never from the proxy.
    const fetch = vi.fn(async () => response("not here", { status: 404, statusText: "Host Not Found" }));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url: "https://news.example.com/missing" })).rejects.toMatchObject({
      code: "AGENT_WEB_FETCH_RESPONSE_FAILED",
      details: { origin: "https://news.example.com", status: 404 },
    });
  });

  it("reads a long page on from where the previous portion ended, letters and emoji intact", async () => {
    const page = "Привет, мир 😀 ".repeat(4_900);
    const fetch = vi.fn(async () => response(page));
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    const first = await execute({ url: "https://example.com/long" });
    const second = await execute({ offset: first.nextOffset!, url: "https://example.com/long" });
    const third = await execute({ offset: second.nextOffset!, url: "https://example.com/long" });

    expect(first).toMatchObject({ offset: 0, totalCharacters: page.length, truncated: true });
    expect(second).toMatchObject({ offset: first.nextOffset, truncated: true });
    expect(third).toMatchObject({ nextOffset: null, truncated: false });
    expect(first.content + second.content + third.content).toBe(page);
    for (const portion of [first, second, third]) {
      expect(wellFormed(portion.content)).toBe(true);
      expect(Buffer.byteLength(portion.content, "utf8")).toBeLessThanOrEqual(CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES);
    }
  });

  it("reads on past the line limit without losing the line break between portions", async () => {
    const page = Array.from({ length: CONTROLLED_WEB_FETCH_MAX_MODEL_LINES + 5 }, (_, index) => `строка ${index}`).join("\n");
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch: vi.fn(async () => response(page)) });

    const first = await execute({ url: "https://example.com/lines" });
    const rest = await execute({ offset: first.nextOffset!, url: "https://example.com/lines" });

    expect(first.content.split("\n")).toHaveLength(CONTROLLED_WEB_FETCH_MAX_MODEL_LINES);
    expect(rest).toMatchObject({ nextOffset: null, offset: first.nextOffset });
    expect(first.content + rest.content).toBe(page);
  });

  it("refuses to start past the end of the page, naming its length", async () => {
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch: vi.fn(async () => response("короткая")) });

    await expect(execute({ offset: 8, url: "https://example.com/short" }))
      .rejects.toThrowError(/AGENT_WEB_FETCH_INPUT_INVALID: .*8 знаков/u);
    await expect(execute({ offset: 0, url: "https://example.com/short" }))
      .resolves.toMatchObject({ content: "короткая", nextOffset: null, totalCharacters: 8 });
    expect(CONTROLLED_WEB_FETCH_INPUT_SCHEMA.safeParse({ offset: -1, url: "https://example.com" }).success).toBe(false);
    expect(CONTROLLED_WEB_FETCH_INPUT_SCHEMA.safeParse({ offset: 1.5, url: "https://example.com" }).success).toBe(false);
    expect(CONTROLLED_WEB_FETCH_INPUT_SCHEMA.safeParse({ offset: CONTROLLED_WEB_FETCH_MAX_BODY_BYTES + 1, url: "https://example.com" }).success)
      .toBe(false);
  });

  it("keeps a byte order mark that opens a portion, so the next portion starts right after it", async () => {
    // A decoder drops a leading U+FEFF by default: the portion came back one character short and
    // the next one began in the middle of an emoji.
    const page = `a\uFEFF${"😀".repeat(CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES / 4)}`;
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch: vi.fn(async () => response(page)) });
    const portions: string[] = [];
    let offset: number | null = 1;

    while (offset !== null) {
      const portion = await execute({ offset, url: "https://example.com/bom" });
      expect(wellFormed(portion.content)).toBe(true);
      portions.push(portion.content);
      offset = portion.nextOffset;
    }

    expect(portions[0]!.startsWith("\uFEFF")).toBe(true);
    expect(portions.join("")).toBe(page.slice(1));
  });

  it("starts an offset that falls inside a character at the start of that character", async () => {
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch: vi.fn(async () => response("😀😀😀")) });

    const portion = await execute({ offset: 3, url: "https://example.com/emoji" });

    expect(portion).toMatchObject({ content: "😀😀", nextOffset: null, offset: 2 });
  });

  it("gives back the whole page text when all portions are read one after another", async () => {
    // What the channel can carry: any code point, line breaks and control characters, in runs long
    // enough to cross both the byte and the line limit of a portion.
    const piece = fc.oneof(
      fc.string({ maxLength: 6, unit: "binary" }),
      fc.constantFrom("\n", "\r\n", "\t", "\u0007", "😀", "я", "line\n"),
    );
    const page = fc.tuple(fc.array(piece, { maxLength: 12, minLength: 1 }), fc.integer({ max: 12_000, min: 0 }))
      .map(([pieces, times]) => pieces.join("").repeat(times));
    // Control characters other than tab and line breaks are never shown; that is the page text.
    const visible = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");

    await fc.assert(fc.asyncProperty(page, async (text) => {
      const execute = createControlledWebFetch({ dispatcher: {} as never, fetch: async () => response(text) });
      const portions: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const portion = await execute({ offset, url: "https://example.com/any" });
        expect(wellFormed(portion.content)).toBe(true);
        expect(Buffer.byteLength(portion.content, "utf8")).toBeLessThanOrEqual(CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES);
        expect(portion.content.split("\n").length).toBeLessThanOrEqual(CONTROLLED_WEB_FETCH_MAX_MODEL_LINES);
        expect(portion.totalCharacters).toBe(visible(text).length);
        expect(portion.content.length > 0 || portion.nextOffset === null).toBe(true);
        portions.push(portion.content);
        offset = portion.nextOffset;
      }
      expect(portions.join("")).toBe(visible(text));
    }), { examples: [[""], ["\n".repeat(CONTROLLED_WEB_FETCH_MAX_MODEL_LINES)], ["😀".repeat(CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES)]], numRuns: 60 });
  });
});
