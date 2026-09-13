import { describe, expect, it, vi } from "vitest";
import { searchPublicWeb } from "./conversation-web-tools.js";

describe("provider-independent web search", () => {
  it.each(["application/json", "text/event-stream"])("reads a bounded %s Exa response without an API key", async (type) => {
    const fetchMock = vi.fn(async (_url, init) => {
      const request = JSON.parse(init!.body as string);
      expect(request.params).toEqual({ name: "web_search_exa", arguments: { query: "Telegram API", numResults: 5 } });
      const json = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "Source: https://core.telegram.org/bots/api" }] } });
      return new Response(type === "application/json" ? json : `event: message\ndata: ${json}\n\n`, { headers: { "content-type": type } });
    });
    await expect(searchPublicWeb({ query: "Telegram API" }, fetchMock)).resolves.toMatchObject({ content: expect.stringContaining("https://core.telegram.org"), truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([400, 500])("does not retry HTTP %s or fabricate results", async (status) => {
    const fetchMock = vi.fn(async () => new Response("failed", { status }));
    await expect(searchPublicWeb({ query: "test" }, fetchMock)).rejects.toThrow("AGENT_WEB_SEARCH_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("reports the quota as a dependency failure for HTTP 429", async () => {
    const fetchMock = vi.fn(async () => new Response("quota", { status: 429 }));
    await expect(searchPublicWeb({ query: "test" }, fetchMock)).rejects.toMatchObject({
      contract: { code: "AGENT_WEB_SEARCH_RATE_LIMITED", category: "dependency", retryable: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["application/json", "text/event-stream"])("rejects Exa's unflagged quota notice in %s", async type => {
    const fetchMock = vi.fn(async (_url, init) => {
      const { id } = JSON.parse(init!.body as string);
      const json = JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text",
        text: "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.\n\nFix: Create API key at https://dashboard.exa.ai/api-keys",
      }] } });
      return new Response(type === "application/json" ? json : `event: message\ndata: ${json}\n\n`, { headers: { "content-type": type } });
    });
    await expect(searchPublicWeb({ query: "test" }, fetchMock)).rejects.toMatchObject({
      code: "AGENT_WEB_SEARCH_RATE_LIMITED", contract: { retryable: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps articles about rate limits as ordinary results", async () => {
    const text = "Title: Exa error guide\nURL: https://example.com/guide\nYou've hit Exa's free MCP rate limit.";
    const result = await searchPublicWeb({ query: "test" }, async (_url, init) => {
      const { id } = JSON.parse(init!.body as string);
      return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    });
    expect(result.content).toBe(text);
  });
  it("preserves the invalid-response code and parsing cause", async () => {
    await expect(searchPublicWeb({ query: "test" }, async () => new Response("not JSON")))
      .rejects.toMatchObject({ code: "AGENT_WEB_SEARCH_RESPONSE_INVALID", cause: expect.any(SyntaxError) });
  });
  it("preserves a timeout as the cause and reports no invented results", async () => {
    const timeout = new DOMException("request timeout", "TimeoutError");
    await expect(searchPublicWeb({ query: "test" }, vi.fn().mockRejectedValue(timeout))).rejects.toMatchObject({ code: "AGENT_WEB_SEARCH_TIMEOUT", cause: timeout });
  });
  it("rejects a mismatched response identity", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "wrong", result: { content: [] } }));
    await expect(searchPublicWeb({ query: "test" }, fetchMock)).rejects.toThrow("AGENT_WEB_SEARCH_RESPONSE_INVALID");
  });
});
