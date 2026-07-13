/**
 * Public-internet-only HTTP CONNECT proxy for trusted sandboxes.
 *
 * Exports:
 * - `createSandboxEgressProxy`: creates the internal proxy server.
 *
 * Security invariants:
 * - DNS is resolved at the proxy and the validated IP is pinned for the connection.
 * - Private/reserved destinations and ports other than HTTP(S) are rejected.
 * - Proxy credentials and hop-by-hop headers are never forwarded.
 */
import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";

import { isPublicInternetAddress } from "./address-policy.js";

const ALLOWED_PORTS = new Set([80, 443]);
const CONNECT_TIMEOUT_MS = 15_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface ResolvedTarget {
  address: string;
  family: 4 | 6;
  hostname: string;
  port: number;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || !ALLOWED_PORTS.has(port)) {
    throw new Error("AGENT_SANDBOX_EGRESS_PORT_FORBIDDEN: Only ports 80 and 443 are allowed");
  }
  return port;
}

async function resolvePublicTarget(hostname: string, port: number): Promise<ResolvedTarget> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  const publicAddress = results.find((result) => isPublicInternetAddress(result.address));
  if (!publicAddress) {
    throw new Error("AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN: Destination is not public");
  }
  return { ...publicAddress, hostname, port };
}

function filteredHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

function rejectSocket(socket: Socket, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
}

function guardClientSocket(socket: Socket): void {
  // Browser cancellation commonly surfaces as EPIPE while a CONNECT tunnel is being piped.
  // The socket is request-scoped, so closing it must never terminate the shared proxy process.
  socket.on("error", (error: NodeJS.ErrnoException) => {
    console.error("Sandbox CONNECT client socket failed", {
      code: error.code ?? "AGENT_SANDBOX_EGRESS_CLIENT_SOCKET_FAILED",
      errorName: error.name,
    });
  });
}

export function createSandboxEgressProxy() {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const targetUrl = new URL(incoming.url ?? "");
      if (targetUrl.protocol !== "http:" || targetUrl.username || targetUrl.password) {
        throw new Error("AGENT_SANDBOX_EGRESS_URL_FORBIDDEN: Only credential-free HTTP URLs are allowed");
      }
      const port = parsePort(targetUrl.port || "80");
      const target = await resolvePublicTarget(targetUrl.hostname, port);
      const upstream = httpRequest({
        family: target.family,
        headers: { ...filteredHeaders(incoming.headers), host: targetUrl.host },
        host: target.address,
        method: incoming.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        port: target.port,
        timeout: CONNECT_TIMEOUT_MS,
      }, (upstreamResponse) => {
        outgoing.writeHead(
          upstreamResponse.statusCode ?? 502,
          filteredHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(outgoing);
      });
      upstream.on("timeout", () => upstream.destroy(
        new Error("AGENT_SANDBOX_EGRESS_TIMEOUT: Upstream connection timed out"),
      ));
      upstream.on("error", (error) => {
        console.error("Sandbox HTTP egress failed", { error, hostname: target.hostname, port });
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end("AGENT_SANDBOX_EGRESS_FAILED: Public destination request failed\n");
      });
      incoming.pipe(upstream);
    })().catch((error: unknown) => {
      console.error("Sandbox HTTP egress rejected", { error, url: incoming.url });
      if (!outgoing.headersSent) outgoing.writeHead(403);
      outgoing.end("AGENT_SANDBOX_EGRESS_FORBIDDEN: Destination is not allowed\n");
    });
  });

  server.on("connect", (request, clientSocket, initialData) => {
    guardClientSocket(clientSocket);
    void (async () => {
      const match = /^\[?([^\]]+)\]?:([0-9]+)$/u.exec(request.url ?? "");
      if (!match) throw new Error("AGENT_SANDBOX_EGRESS_CONNECT_INVALID: Invalid CONNECT target");
      const port = parsePort(match[2]!);
      const target = await resolvePublicTarget(match[1]!, port);
      const upstream = connect({
        family: target.family,
        host: target.address,
        port,
        timeout: CONNECT_TIMEOUT_MS,
      });
      upstream.once("connect", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (initialData.byteLength > 0) upstream.write(initialData);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once("timeout", () => upstream.destroy(
        new Error("AGENT_SANDBOX_EGRESS_TIMEOUT: CONNECT timed out"),
      ));
      upstream.once("error", (error) => {
        console.error("Sandbox CONNECT failed", { error, hostname: target.hostname, port });
        rejectSocket(clientSocket, 502, "Bad Gateway");
      });
    })().catch((error: unknown) => {
      console.error("Sandbox CONNECT rejected", { error, target: request.url });
      rejectSocket(clientSocket, 403, "Forbidden");
    });
  });

  return server;
}
