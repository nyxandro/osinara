/**
 * Plain HTTP through the sandbox egress proxy over real local sockets.
 *
 * Constructs covered (#462):
 * - A sandbox client that drops a download halfway, as apt does with a package it cannot store,
 *   ends the request to the site at once. It is recorded as the client's own routine close, not
 *   left idle until a timeout blamed on the site.
 * - A site that drops its response halfway, closing or resetting its connection, ends the response
 *   to the sandbox, so its client stops waiting. A site ending a connection it already answered on
 *   is routine traffic, as on an established tunnel.
 * - A client gone before the proxy has decided where to connect leaves no request to the site
 *   behind, and no tracked connection to an owner-granted address.
 *
 * Real sockets, because what matters here is how Node's HTTP client and server report a connection
 * one side closed: a stub of `node:http` would only repeat the assumptions under test.
 */
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSandboxEgressProxy } from "./server.js";

// The site is a local server reached by its address, which the gate allows as an owner grant would.
const allowLocalSite = { authorize: async () => undefined };
const PACKAGE_PATH = "/debian/pool/main/y/yt-dlp/yt-dlp_2023.03.04-1_all.deb";
// Well inside the proxy's 15-second idle timeout, which the old behaviour waited out.
const PROMPT_MILLISECONDS = 3_000;

type Logged = { stream: "error" | "info"; record: Record<string, unknown> };

let logged: Logged[];
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${PROMPT_MILLISECONDS} ms`)), PROMPT_MILLISECONDS);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A site that sends the headers and the first part of a package, then holds the rest. */
async function slowSite() {
  let siteSocket: Socket | undefined;
  let response: ServerResponse | undefined;
  const requested = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const port = await listen(createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    siteSocket = incoming.socket;
    response = outgoing;
    incoming.socket.once("close", () => closed.resolve());
    outgoing.writeHead(200, { "content-length": "1048576", "content-type": "application/vnd.debian.binary-package" });
    outgoing.write(Buffer.alloc(64 * 1024, 1));
    requested.resolve();
  }));
  return { closed: closed.promise, port, requested: requested.promise, response: () => response!, socket: () => siteSocket! };
}

async function proxyPort(): Promise<number> {
  return await listen(createSandboxEgressProxy({ grantRecheckMilliseconds: 60_000, networkAccess: allowLocalSite }));
}

/** A sandbox client asking the proxy for the package, as apt does over plain HTTP. */
function download(proxy: number, site: number) {
  const target = `http://127.0.0.1:${site}${PACKAGE_PATH}`;
  const outgoing = request({ headers: { host: `127.0.0.1:${site}` }, host: "127.0.0.1", path: target, port: proxy });
  outgoing.on("error", () => undefined);
  const response = new Promise<IncomingMessage>((resolve) => outgoing.once("response", resolve));
  outgoing.end();
  return { outgoing, response };
}

describe("plain HTTP through the sandbox egress proxy", () => {
  beforeEach(() => {
    logged = [];
    const capture = (stream: Logged["stream"]) => (line: string) => {
      logged.push({ record: JSON.parse(line) as Record<string, unknown>, stream });
    };
    vi.spyOn(console, "info").mockImplementation(capture("info"));
    vi.spyOn(console, "error").mockImplementation(capture("error"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("ends the request to the site once the sandbox drops the download (#462)", async () => {
    const site = await slowSite();
    const proxy = await proxyPort();
    const client = download(proxy, site.port);
    const response = await within(client.response, "the first bytes of the package");
    await within(site.requested, "the request reaching the site");

    // apt could not store the package and hangs up halfway.
    response.destroy();
    client.outgoing.destroy();

    await within(site.closed, "the site's connection closing");
    // Let the proxy finish what it does on that close.
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged).toEqual([{
      record: { code: "AGENT_SANDBOX_EGRESS_CLIENT_CLOSED", hostname: "127.0.0.1", phase: "response", port: site.port },
      stream: "info",
    }]);
  });

  it("ends the response to the sandbox once the site drops it halfway (#462)", async () => {
    const site = await slowSite();
    const proxy = await proxyPort();
    const client = download(proxy, site.port);
    const response = await within(client.response, "the first bytes of the package");
    const ended = new Promise<void>((resolve) => response.once("close", () => resolve()));
    response.resume();

    site.socket().destroy();

    await within(ended, "the sandbox's response ending");
    expect(response.complete).toBe(false);
    expect(logged).toEqual([{
      record: { code: "AGENT_SANDBOX_EGRESS_UPSTREAM_CLOSED", hostname: "127.0.0.1", phase: "response", port: site.port },
      stream: "info",
    }]);
  });

  it("ends the response to the sandbox once the site resets its connection halfway (#462)", async () => {
    const site = await slowSite();
    const proxy = await proxyPort();
    const client = download(proxy, site.port);
    const response = await within(client.response, "the first bytes of the package");
    const ended = new Promise<void>((resolve) => response.once("close", () => resolve()));
    response.resume();

    site.socket().resetAndDestroy();

    await within(ended, "the sandbox's response ending");
    expect(response.complete).toBe(false);
    expect(logged).toEqual([{
      record: { code: "AGENT_SANDBOX_EGRESS_UPSTREAM_CLOSED", hostname: "127.0.0.1", phase: "response", port: site.port },
      stream: "info",
    }]);
  });

  it("opens nothing to a site for a client gone before its address was decided", async () => {
    let siteConnections = 0;
    const sitePort = await listen(createServer(() => undefined).on("connection", () => { siteConnections += 1; }));
    const deciding = Promise.withResolvers<void>();
    const decided = Promise.withResolvers<void>();
    let checks = 0;
    // The grant check takes a while and the client hangs up meanwhile. Every later check refuses, as
    // a revocation would: a connection left tracked for that address would be rechecked and closed.
    const slowGate = {
      authorize: async () => {
        checks += 1;
        if (checks > 1) throw new Error("revoked");
        deciding.resolve();
        await new Promise((resolve) => setTimeout(resolve, 300));
        decided.resolve();
      },
    };
    const proxy = await listen(createSandboxEgressProxy({ grantRecheckMilliseconds: 200, networkAccess: slowGate }));
    const client = download(proxy, sitePort);

    // The client hangs up only once the proxy is deciding, so the case under test really happens.
    await within(deciding.promise, "the proxy starting to decide");
    client.outgoing.destroy();
    await within(decided.promise, "the grant decision");
    // Long enough for several rechecks of anything still tracked.
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(siteConnections).toBe(0);
    expect(checks).toBe(1);
    expect(logged).toEqual([]);
  });

  it("logs nothing for a download that completes", async () => {
    const site = await slowSite();
    const proxy = await proxyPort();
    const client = download(proxy, site.port);
    const response = await within(client.response, "the first bytes of the package");
    const finished = new Promise<void>((resolve) => response.once("end", () => resolve()));
    response.resume();
    await within(site.requested, "the request reaching the site");

    site.response().end(Buffer.alloc(1048576 - 64 * 1024, 1));

    await within(finished, "the whole package arriving");
    expect(response.complete).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged).toEqual([]);
  });
});
