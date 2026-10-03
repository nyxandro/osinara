/**
 * Public-internet-only HTTP CONNECT proxy for trusted sandboxes.
 *
 * Exports:
 * - `bindTunnelLifecycle`: prevents either side of a CONNECT tunnel from becoming orphaned.
 * - `connectWithDeadline`: bounds TCP establishment without timing out an established idle tunnel.
 * - `createSandboxEgressProxy`: creates the internal proxy server.
 *
 * Security invariants:
 * - DNS is resolved at the proxy and the validated IP is pinned for the connection.
 * - Private/reserved destinations and ports other than HTTP(S) are rejected.
 * - Proxy credentials and hop-by-hop headers are never forwarded.
 * - Logs name the destination host, never a full URL: it may carry credentials or tokens.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";

import {
  SANDBOX_EGRESS_CLIENT_CLOSED_CODE,
  SANDBOX_EGRESS_UPSTREAM_CLOSED_CODE,
  writeEgressLog,
} from "./egress-log.js";
import { resolvePublicInternetAddress } from "./public-dns-resolver.js";

const ALLOWED_PORTS = new Set([80, 443]);
const CONNECT_TIMEOUT_MS = 15_000;
// How a client closing its side of the connection surfaces on the proxy socket.
const CLIENT_CLOSED_ERROR_CODES = new Set(["ECONNRESET", "EPIPE"]);
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
  family: 4;
  hostname: string;
  port: number;
}

type ConnectPhase = "connect" | "request" | "resolution" | "tunnel";

export function bindTunnelLifecycle(clientSocket: Socket, upstream: Socket): void {
  let upstreamTerminated = upstream.destroyed;
  let clientTerminated = clientSocket.destroyed || clientSocket.writableEnded;
  const destroyUpstream = () => {
    if (upstreamTerminated || upstream.destroyed) return;
    upstreamTerminated = true;
    upstream.destroy();
  };
  const endClient = () => {
    if (clientTerminated || clientSocket.destroyed || clientSocket.writableEnded) return;
    clientTerminated = true;
    clientSocket.end();
  };
  clientSocket.once("error", destroyUpstream);
  clientSocket.once("close", destroyUpstream);
  upstream.once("close", endClient);
}

export function connectWithDeadline(
  createSocket: () => Socket,
  timeoutMilliseconds: number,
): Socket {
  const socket = createSocket();
  const deadline = setTimeout(() => socket.destroy(
    new Error("AGENT_SANDBOX_EGRESS_TIMEOUT: CONNECT timed out before establishment"),
  ), timeoutMilliseconds);
  deadline.unref();
  const clearDeadline = () => clearTimeout(deadline);
  socket.once("connect", clearDeadline);
  socket.once("error", clearDeadline);
  socket.once("close", clearDeadline);
  return socket;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || !ALLOWED_PORTS.has(port)) {
    throw new Error("AGENT_SANDBOX_EGRESS_PORT_FORBIDDEN: Only ports 80 and 443 are allowed");
  }
  return port;
}

async function resolvePublicTarget(hostname: string, port: number): Promise<ResolvedTarget> {
  // Resolve outside host VPN fake-IP DNS, then pin the validated address for this connection.
  const publicAddress = await resolvePublicInternetAddress(hostname);
  return { ...publicAddress, hostname, port };
}

function filteredHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function urlHost(url: string | undefined): string | null {
  return url !== undefined && URL.canParse(url) ? new URL(url).host : null;
}

// A CONNECT target is `host:port`; anything a client put before an `@` would be credentials.
function connectTargetForLog(target: string | undefined): string | null {
  return target === undefined ? null : target.slice(target.lastIndexOf("@") + 1);
}

function rejectSocket(socket: Socket, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
}

function guardClientSocket(socket: Socket, phase: () => ConnectPhase): () => boolean {
  let unavailable = socket.destroyed;
  // Browser cancellation commonly surfaces as EPIPE while a CONNECT tunnel is being piped.
  // The socket is request-scoped, so closing it must never terminate the shared proxy process.
  socket.on("error", (error: NodeJS.ErrnoException) => {
    unavailable = true;
    const closed = error.code !== undefined && CLIENT_CLOSED_ERROR_CODES.has(error.code);
    writeEgressLog({
      code: closed ? SANDBOX_EGRESS_CLIENT_CLOSED_CODE : "AGENT_SANDBOX_EGRESS_CLIENT_SOCKET_FAILED",
      errorCode: error.code ?? null,
      errorName: error.name,
      phase: phase(),
    });
  });
  socket.once("close", () => {
    unavailable = true;
  });
  return () => unavailable;
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
      upstream.on("error", (error: NodeJS.ErrnoException) => {
        writeEgressLog({
          code: "AGENT_SANDBOX_EGRESS_HTTP_FAILED",
          errorCode: error.code ?? null,
          errorMessage: error.message,
          hostname: target.hostname,
          port,
        });
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end("AGENT_SANDBOX_EGRESS_FAILED: Public destination request failed\n");
      });
      incoming.pipe(upstream);
    })().catch((error: unknown) => {
      writeEgressLog({
        code: "AGENT_SANDBOX_EGRESS_HTTP_REJECTED",
        errorMessage: errorMessage(error),
        host: urlHost(incoming.url),
      });
      if (!outgoing.headersSent) outgoing.writeHead(403);
      outgoing.end("AGENT_SANDBOX_EGRESS_FORBIDDEN: Destination is not allowed\n");
    });
  });

  server.on("connect", (request, clientSocket, initialData) => {
    let phase: ConnectPhase = "request";
    const clientUnavailable = guardClientSocket(clientSocket, () => phase);
    void (async () => {
      const match = /^\[?([^\]]+)\]?:([0-9]+)$/u.exec(request.url ?? "");
      if (!match) throw new Error("AGENT_SANDBOX_EGRESS_CONNECT_INVALID: Invalid CONNECT target");
      const port = parsePort(match[2]!);
      phase = "resolution";
      const target = await resolvePublicTarget(match[1]!, port);
      if (clientUnavailable()) return;
      phase = "connect";
      const upstream = connectWithDeadline(() => connect({
        family: target.family,
        host: target.address,
        port,
      }), CONNECT_TIMEOUT_MS);
      bindTunnelLifecycle(clientSocket, upstream);
      if (clientUnavailable()) {
        upstream.destroy();
        return;
      }
      upstream.once("connect", () => {
        phase = "tunnel";
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (initialData.byteLength > 0) upstream.write(initialData);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once("error", (error: NodeJS.ErrnoException) => {
        writeEgressLog({
          code: phase === "tunnel" ? SANDBOX_EGRESS_UPSTREAM_CLOSED_CODE : "AGENT_SANDBOX_EGRESS_UPSTREAM_FAILED",
          errorCode: error.code ?? null,
          errorMessage: error.message,
          hostname: target.hostname,
          phase,
          port,
        });
        rejectSocket(clientSocket, 502, "Bad Gateway");
      });
    })().catch((error: unknown) => {
      writeEgressLog({
        code: "AGENT_SANDBOX_EGRESS_CONNECT_REJECTED",
        errorMessage: errorMessage(error),
        phase,
        target: connectTargetForLog(request.url),
      });
      rejectSocket(clientSocket, 403, "Forbidden");
    });
  });

  return server;
}
