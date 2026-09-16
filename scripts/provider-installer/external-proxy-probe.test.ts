/**
 * External proxy probe tests.
 *
 * Constructs covered:
 * - End-to-end token round trip through a proxy that forwards to the loopback edge port.
 * - Gateway errors accepted as "upstream not created yet".
 * - Anything else answering for the hostname fails closed before migration.
 */
import { createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { probeExternalProxy } from "./external-proxy-probe.js";

async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")));
    });
  });
}

/** Behaves like a host-level reverse proxy: terminates "TLS" and forwards to the loopback edge port. */
function forwardingFetch(port: number): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    return await fetch(`http://127.0.0.1:${port}${url.pathname}`, { signal: init?.signal });
  };
}

describe("probeExternalProxy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes when the proxy forwards the hostname to the edge port end to end", async () => {
    const port = await freeLoopbackPort();
    await expect(probeExternalProxy({ fetch: forwardingFetch(port), hostname: "bot.example.com", listenPort: port }))
      .resolves.toBeUndefined();
  });

  it.each([502, 503, 504])("accepts gateway status %i from a proxy whose upstream does not exist yet", async (status) => {
    const port = await freeLoopbackPort();
    const proxy = vi.fn(async () => new Response("bad gateway", { status }));
    await expect(probeExternalProxy({ fetch: proxy as unknown as typeof fetch, hostname: "bot.example.com", listenPort: port }))
      .resolves.toBeUndefined();
    expect(proxy).toHaveBeenCalledWith("https://bot.example.com/eve/v1/health", expect.objectContaining({ redirect: "manual" }));
  });

  it.each([
    ["a default vhost answering 200", new Response("welcome", { status: 200 })],
    ["a proxy without a matching router", new Response("", { status: 404 })],
    ["a redirect elsewhere", new Response("", { status: 301, headers: { location: "https://other.example" } })],
  ])("fails closed when %s serves the hostname instead of Osinara", async (_label, answer) => {
    const port = await freeLoopbackPort();
    const proxy = vi.fn(async () => answer);
    await expect(probeExternalProxy({ fetch: proxy as unknown as typeof fetch, hostname: "bot.example.com", listenPort: port }))
      .rejects.toMatchObject({ code: "OSINARA_INSTALL_EXTERNAL_PROXY_MISROUTED" });
  });

  it("reports an unreachable proxy with the cause and releases the edge port", async () => {
    const port = await freeLoopbackPort();
    const proxy = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(probeExternalProxy({ fetch: proxy as unknown as typeof fetch, hostname: "bot.example.com", listenPort: port }))
      .rejects.toMatchObject({ code: "OSINARA_INSTALL_EXTERNAL_PROXY_UNREACHABLE" });
    // The port must be free again for the real edge container.
    await expect(probeExternalProxy({ fetch: forwardingFetch(port), hostname: "bot.example.com", listenPort: port }))
      .resolves.toBeUndefined();
  });
});
