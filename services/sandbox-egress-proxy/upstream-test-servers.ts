/**
 * Real local servers for the tests of the sandbox egress proxy's upstream route (#489).
 *
 * The fake upstream proxy behaves like the host Xray where it matters: a tunnel is opened with CONNECT
 * to the address asked for, and when the destination cannot be reached Xray has already answered 200
 * and only closes or resets the tunnel without a byte.
 *
 * A test file using these servers mocks `./public-dns-resolver.js` so that every name resolves to
 * 127.0.0.1, where the servers listen, and calls `closeServers` after each test.
 */
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";

import { vi } from "vitest";

import { createSandboxEgressProxy } from "./server.js";

export const DEADLINE_MILLISECONDS = 3_000;

// Host names never reach the gate; an IP destination is the owner's grant and always allowed here.
const grantsEveryAddress = { authorize: async () => undefined };

export type Logged = { stream: "error" | "info"; record: Record<string, unknown> };
type AnyServer = Server | ReturnType<typeof createTcpServer>;

const servers: AnyServer[] = [];
// Tunnels outlive their requests, so every accepted connection is closed by hand after a test.
const sockets = new Set<Socket>();

/** Collects the proxy's log records, which go to the console as one JSON line each. */
export function captureLogs(): Logged[] {
  const logged: Logged[] = [];
  const capture = (stream: Logged["stream"]) => (line: string) => {
    logged.push({ record: JSON.parse(line) as Record<string, unknown>, stream });
  };
  vi.spyOn(console, "info").mockImplementation(capture("info"));
  vi.spyOn(console, "error").mockImplementation(capture("error"));
  return logged;
}

export async function closeServers(): Promise<void> {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function listen(server: AnyServer): Promise<number> {
  servers.push(server);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

export async function within<T>(promise: Promise<T>, what: string, milliseconds = DEADLINE_MILLISECONDS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not happen within ${milliseconds} ms`)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Lets the events already queued on the sockets run, so that their log records are written. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Resolves once the other side has gone: a closed or half-closed connection. */
export async function released(socket: Socket): Promise<void> {
  await new Promise<void>((resolve) => {
    socket.once("end", () => resolve());
    socket.once("close", () => resolve());
  });
}

/** A TLS-like site: whatever reaches it comes back. */
export async function echoSite(): Promise<number> {
  return await listen(createTcpServer((socket) => socket.pipe(socket)));
}

/** A site that answers the first bytes it gets and closes the connection. */
export async function answerOnceSite(): Promise<number> {
  return await listen(createTcpServer((socket) => socket.once("data", () => socket.end("answer"))));
}

/** A plain HTTP site that records the name and path each request came with. */
export async function httpSite(delayMilliseconds = 0) {
  const seen: Array<{ host: string | undefined; url: string | undefined }> = [];
  const port = await listen(createServer((incoming, outgoing) => {
    seen.push({ host: incoming.headers.host, url: incoming.url });
    setTimeout(() => outgoing.end("страница сайта"), delayMilliseconds);
  }));
  return { port, seen };
}

/**
 * How the fake upstream proxy treats a CONNECT:
 * - "tunnel": port 80 goes to the HTTP site, any other port to the TLS-like site;
 * - "refuse": answers 502;
 * - "silent": answers 200 like Xray does before it dials, then closes without a byte;
 * - "reset": answers 200, then resets the connection once the client speaks;
 * - "stall": never answers, as an upstream proxy that hangs.
 */
type UpstreamBehaviour = "refuse" | "reset" | "silent" | "stall" | "tunnel";

export async function upstreamProxy(sites: { http?: number; tls?: number }, behaviour: UpstreamBehaviour = "tunnel") {
  const tunnels: string[] = [];
  let stalledSocket: (socket: Socket) => void = () => undefined;
  const stalled = new Promise<Socket>((resolve) => { stalledSocket = resolve; });
  const server = createServer((_incoming, outgoing) => {
    outgoing.statusCode = 400;
    outgoing.end("absolute-form requests are not expected");
  });
  server.on("connect", (incoming: IncomingMessage, socket: Socket) => {
    tunnels.push(incoming.url ?? "");
    socket.on("error", () => undefined);
    if (behaviour === "refuse") {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (behaviour === "stall") {
      stalledSocket(socket);
      return;
    }
    if (behaviour === "silent") {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      setTimeout(() => socket.end(), 50);
      return;
    }
    if (behaviour === "reset") {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.once("data", () => socket.resetAndDestroy());
      return;
    }
    const sitePort = incoming.url?.endsWith(":80") ? sites.http : sites.tls;
    const site = connect(sitePort!, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      site.pipe(socket);
      socket.pipe(site);
    });
    site.on("error", () => socket.destroy());
    socket.on("error", () => site.destroy());
  });
  const port = await listen(server);
  return { port, stalled, tunnels };
}

/** An egress proxy whose tally of opened and unreachable sites the test reads (#499). */
export async function measuredEgressProxy(upstreamPort: number | null) {
  const sites = { failed: 0, opened: 0 };
  const port = await listen(createSandboxEgressProxy({
    grantRecheckMilliseconds: 60_000,
    networkAccess: grantsEveryAddress,
    siteMeter: { failed: () => { sites.failed += 1; }, opened: () => { sites.opened += 1; } },
    ...(upstreamPort === null ? {} : { upstreamProxy: { host: "127.0.0.1", port: upstreamPort } }),
  }));
  return { port, sites };
}

export async function egressProxy(upstreamPort: number | null): Promise<number> {
  return (await measuredEgressProxy(upstreamPort)).port;
}

/** Opens a CONNECT tunnel through the egress proxy, as a sandbox client does. */
export async function tunnel(proxyPort: number, target: string): Promise<{ socket: Socket; status: number }> {
  return await within(new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", method: "CONNECT", path: target, port: proxyPort });
    outgoing.on("connect", (response, socket) => resolve({ socket, status: response.statusCode ?? 0 }));
    outgoing.on("error", reject);
    outgoing.end();
  }), `the tunnel to ${target}`);
}

/** A plain HTTP request through the egress proxy, as curl or apt sends it. */
export async function plainGet(
  proxyPort: number,
  url: string,
  deadlineMilliseconds = DEADLINE_MILLISECONDS,
): Promise<{ body: string; status: number }> {
  return await within(new Promise((resolve, reject) => {
    const outgoing = request({ headers: { host: new URL(url).host }, host: "127.0.0.1", path: url, port: proxyPort }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ body, status: response.statusCode ?? 0 }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  }), `the answer for ${url}`, deadlineMilliseconds);
}

/** Sends a request through the egress proxy and returns it unanswered, for a client that leaves early. */
export function pendingRequest(proxyPort: number, method: "CONNECT" | "GET", target: string) {
  const outgoing = method === "CONNECT"
    ? request({ host: "127.0.0.1", method, path: target, port: proxyPort })
    : request({ headers: { host: new URL(target).host }, host: "127.0.0.1", path: target, port: proxyPort });
  outgoing.on("error", () => undefined);
  outgoing.end();
  return outgoing;
}

export async function unusedPort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
