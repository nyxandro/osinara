/**
 * Controlled external-group web fetch tests.
 *
 * Constructs covered:
 * - `createControlledWebFetch`: injectable proxied HTTP executor with strict URL and resource limits;
 *   a refusing site's status reaches the model, its origin only the diagnostics.
 * - `controlledWebFetchTool`: Eve-compatible custom `web_fetch` definition.
 */
import { Buffer } from "node:buffer";

import { ProxyAgent, type RequestInit, type Response } from "undici";
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

function response(body: BodyInit | null, init?: ResponseInit): Response {
  return new globalThis.Response(body, init) as unknown as Response;
}

describe("controlled external-group web fetch", () => {
  it("preserves the Eve input contract and always dispatches through the fixed proxy", async () => {
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
    const fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:3128");
    });
    const execute = createControlledWebFetch({ dispatcher: {} as never, fetch });

    await expect(execute({ url: "https://example.com" })).rejects.toThrowError(
      "AGENT_WEB_FETCH_REQUEST_FAILED: Не удалось загрузить страницу через защищённый шлюз. Попробуйте позже",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
