/**
 * What the egress proxy counts as a site opened and a site that could not be reached (#499).
 *
 * The tally feeds OsinaraSitesUnreachable: a whole day of attempts with nothing opened. A site counts
 * once, when its connection is decided: opened when the tunnel is established or the response
 * begins, failed when the connection, the answer or the name's resolution did not come. What the
 * proxy refuses on purpose and a name that does not exist are neither: they say nothing about
 * whether sites open from here.
 *
 * Constructs covered:
 * - Direct CONNECT: an established tunnel is opened, a connection that failed is failed, and a site
 *   dropping the tunnel later is not counted again.
 * - Plain HTTP: a response that began is opened, once, even when the site stalls later; a request with
 *   no response is failed.
 * - An owner-granted address is a device of the owner's, not a site, and is not counted.
 * - A resolver that did not answer is failed and logged under its own code, a site failure that the
 *   burst alert does not count; a name that does not exist and a refused port are not counted.
 */
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ connect: vi.fn(), request: vi.fn() }));

vi.mock("node:net", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:net")>(),
  connect: network.connect,
}));
vi.mock("node:http", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:http")>(),
  request: network.request,
}));
const resolver = vi.hoisted(() => ({
  resolvePublicInternetAddress: vi.fn(async (_hostname: string) => ({ address: "93.184.216.34", family: 4 as const })),
}));
vi.mock("./public-dns-resolver.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./public-dns-resolver.js")>(),
  resolvePublicInternetAddress: resolver.resolvePublicInternetAddress,
}));

const { createSandboxEgressProxy } = await import("./server.js");
const { SANDBOX_EGRESS_ROUTINE_CODES, SANDBOX_EGRESS_SITE_FAILURE_CODES } = await import("./egress-log.js");
const { EgressHostNotFound, EgressResolutionFailed } = await import("./public-dns-resolver.js");

// These cases use host names only, which never reach the network access gate.
const hostNamesOnly = {
  authorize: async () => {
    throw new Error("The network access gate must not be consulted for a host name");
  },
};

let sites: { failed: number; opened: number };
let lines: Array<{ stream: "error" | "info"; text: string }>;

function proxy(networkAccess: { authorize: (request: never) => Promise<void> } = hostNamesOnly) {
  return createSandboxEgressProxy({
    grantRecheckMilliseconds: 60_000,
    networkAccess,
    siteMeter: { failed: () => { sites.failed += 1; }, opened: () => { sites.opened += 1; } },
  });
}

function errnoError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function openTunnel(target: string) {
  const server = proxy();
  const client = new PassThrough() as unknown as Socket;
  const upstream = new PassThrough() as unknown as Socket;
  network.connect.mockReturnValue(upstream);
  server.emit("connect", { url: target }, client, Buffer.alloc(0));
  await settle();
  return { server, upstream };
}

function plainRequest(url: string) {
  const server = proxy();
  const upstream = Object.assign(new PassThrough(), { destroy: vi.fn() });
  let answer: ((response: unknown) => void) | undefined;
  network.request.mockImplementation((_options: unknown, onResponse: (response: unknown) => void) => {
    answer = onResponse;
    return upstream as unknown as ClientRequest;
  });
  const incoming = Object.assign(new PassThrough(), {
    headers: {}, method: "GET", socket: { localAddress: "172.20.0.3" }, url,
  });
  const outgoing = Object.assign(new EventEmitter(), {
    destroy: vi.fn(), end: vi.fn(), headersSent: false, writeHead: vi.fn(),
  });
  server.emit("request", incoming as unknown as IncomingMessage, outgoing as unknown as ServerResponse);
  return { answer: () => answer!, outgoing, server, upstream };
}

describe("sites the egress proxy opened and could not reach", () => {
  beforeEach(() => {
    sites = { failed: 0, opened: 0 };
    lines = [];
    vi.spyOn(console, "info").mockImplementation((text: string) => { lines.push({ stream: "info", text }); });
    vi.spyOn(console, "error").mockImplementation((text: string) => { lines.push({ stream: "error", text }); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    network.connect.mockReset();
    network.request.mockReset();
  });

  it("counts an established tunnel as opened, once, even when the site drops it later", async () => {
    const { server, upstream } = await openTunnel("example.com:443");

    upstream.emit("connect");
    upstream.emit("error", errnoError("read ECONNRESET", "ECONNRESET"));

    expect(sites).toEqual({ failed: 0, opened: 1 });
    server.removeAllListeners();
  });

  it("counts a site that could not be connected as failed", async () => {
    const { server, upstream } = await openTunnel("incrussia.ru:443");

    upstream.emit("error", new Error("AGENT_SANDBOX_EGRESS_TIMEOUT: CONNECT timed out before establishment"));

    expect(sites).toEqual({ failed: 1, opened: 0 });
    server.removeAllListeners();
  });

  it("counts a plain HTTP response that began as opened", async () => {
    const { answer, server } = plainRequest("http://example.com/page");
    await settle();

    const response = Object.assign(new PassThrough(), { complete: true, headers: {}, statusCode: 200 });
    answer()(response);

    expect(sites).toEqual({ failed: 0, opened: 1 });
    server.removeAllListeners();
  });

  it("counts a response that began once, even when the site then stalls", async () => {
    const { answer, server, upstream } = plainRequest("http://example.com/page");
    await settle();

    answer()(Object.assign(new PassThrough(), { complete: false, headers: {}, statusCode: 200 }));
    upstream.emit("timeout");
    upstream.emit("error", new Error("AGENT_SANDBOX_EGRESS_TIMEOUT: Upstream connection timed out"));

    expect(sites).toEqual({ failed: 0, opened: 1 });
    server.removeAllListeners();
  });

  it("does not count an owner's device reached by its granted address", async () => {
    const server = proxy({ authorize: async () => undefined });
    const client = new PassThrough() as unknown as Socket;
    const reached = new PassThrough() as unknown as Socket;
    const unreachable = new PassThrough() as unknown as Socket;
    network.connect.mockReturnValueOnce(reached).mockReturnValueOnce(unreachable);
    server.emit("connect", { url: "100.91.171.16:8123" }, client, Buffer.alloc(0));
    server.emit("connect", { url: "100.91.171.16:8124" }, new PassThrough() as unknown as Socket, Buffer.alloc(0));
    await settle();

    reached.emit("connect");
    unreachable.emit("error", errnoError("connect ECONNREFUSED 100.91.171.16:8124", "ECONNREFUSED"));

    expect(sites).toEqual({ failed: 0, opened: 0 });
    // Two stand-in streams piped into each other echo forever; close the tunnel like a client would.
    client.destroy();
    reached.destroy();
    server.removeAllListeners();
  });

  it("counts a plain HTTP request without a response as failed", async () => {
    const { server, upstream } = plainRequest("http://example.com/page");
    await settle();

    upstream.emit("error", errnoError("connect ETIMEDOUT 93.184.216.34:80", "ETIMEDOUT"));

    expect(sites).toEqual({ failed: 1, opened: 0 });
    server.removeAllListeners();
  });

  it("counts a site whose name the resolver did not answer for as failed, under a code of its own", async () => {
    resolver.resolvePublicInternetAddress.mockRejectedValueOnce(new EgressResolutionFailed("slow-dns.example.ru", "ETIMEOUT"));
    const { server } = await openTunnel("slow-dns.example.ru:443");

    expect(sites).toEqual({ failed: 1, opened: 0 });
    expect(lines.map(({ text }) => JSON.parse(text) as Record<string, unknown>)).toEqual([{
      code: "AGENT_SANDBOX_EGRESS_IPV4_RESOLUTION_FAILED",
      dnsCode: "ETIMEOUT",
      phase: "resolution",
      target: "slow-dns.example.ru:443",
    }]);
    // One site whose DNS did not answer is not an alert; a day of them is OsinaraSitesUnreachable.
    expect(SANDBOX_EGRESS_SITE_FAILURE_CODES).toContain("AGENT_SANDBOX_EGRESS_IPV4_RESOLUTION_FAILED");
    expect(SANDBOX_EGRESS_ROUTINE_CODES).not.toContain("AGENT_SANDBOX_EGRESS_IPV4_RESOLUTION_FAILED");
    server.removeAllListeners();
  });

  it("counts the same on the plain HTTP path", async () => {
    resolver.resolvePublicInternetAddress.mockRejectedValueOnce(new EgressResolutionFailed("slow-dns.example.ru", "ESERVFAIL"));
    const { server } = plainRequest("http://slow-dns.example.ru/page?token=t0ken");
    await settle();

    expect(sites).toEqual({ failed: 1, opened: 0 });
    expect(lines.map(({ text }) => JSON.parse(text) as Record<string, unknown>)).toEqual([{
      code: "AGENT_SANDBOX_EGRESS_IPV4_RESOLUTION_FAILED",
      dnsCode: "ESERVFAIL",
      host: "slow-dns.example.ru",
    }]);
    server.removeAllListeners();
  });

  it("counts neither a name that does not exist nor a port the proxy refuses", async () => {
    resolver.resolvePublicInternetAddress.mockRejectedValueOnce(new EgressHostNotFound("fivpost.ru", "ENOTFOUND"));
    const missing = await openTunnel("fivpost.ru:443");
    const refused = await openTunnel("mtalk.google.com:5228");

    expect(sites).toEqual({ failed: 0, opened: 0 });
    missing.server.removeAllListeners();
    refused.server.removeAllListeners();
  });

  it("names the codes of a site that did not open apart from the proxy's own failures", () => {
    // A refusal by the proxy's own rules and a broken client socket stay counted by the burst alert.
    expect([...SANDBOX_EGRESS_SITE_FAILURE_CODES].sort()).toEqual([
      "AGENT_SANDBOX_EGRESS_HTTP_FAILED",
      "AGENT_SANDBOX_EGRESS_IPV4_RESOLUTION_FAILED",
      "AGENT_SANDBOX_EGRESS_UPSTREAM_FAILED",
    ]);
  });
});
