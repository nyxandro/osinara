/**
 * Public-internet-only HTTP CONNECT proxy for trusted sandboxes.
 *
 * Exports:
 * - `bindTunnelLifecycle`: prevents either side of a CONNECT tunnel from becoming orphaned.
 * - `connectWithDeadline`: bounds TCP establishment without timing out an established idle tunnel.
 * - `SandboxEgressProxyOptions`: the owner-approved network access gate and how often open
 *   connections to IP destinations are rechecked against it.
 * - `createSandboxEgressProxy`: creates the internal proxy server.
 *
 * Security invariants:
 * - DNS is resolved at the proxy and the validated IP is pinned for the connection.
 * - A host name reaches only public destinations on ports 80 and 443.
 * - An IP address on any port is reached only when the network access gate allows it; a host name
 *   made of digits and dots is treated as an address and never resolved. An open connection to it
 *   is closed once a recheck finds the grant gone.
 * - Proxy credentials and hop-by-hop headers are never forwarded.
 * - Logs name the destination host, never a full URL: it may carry credentials or tokens.
 */
import { createServer, request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";

import {
  SANDBOX_EGRESS_CLIENT_CLOSED_CODE,
  SANDBOX_EGRESS_UPSTREAM_CLOSED_CODE,
  writeEgressLog,
} from "./egress-log.js";
import { filteredHeaders } from "./http-headers.js";
import { createGrantedConnectionRegistry } from "./granted-connection-registry.js";
import { NetworkAccessRefusal, type NetworkAccessGate } from "./network-access-gate.js";
import { resolvePublicInternetAddress } from "./public-dns-resolver.js";

const ALLOWED_PORTS = new Set([80, 443]);
const MAX_PORT = 65_535;
const IP_LITERAL_HOST = /^[0-9.]+$/u;
const CONNECT_TIMEOUT_MS = 15_000;
// How a client closing its side of the connection surfaces on the proxy socket.
const CLIENT_CLOSED_ERROR_CODES = new Set(["ECONNRESET", "EPIPE"]);

interface ResolvedTarget {
  address: string;
  family: 4;
  /** The network access gate allowed it, so the connection is rechecked while it stays open. */
  granted: boolean;
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

export interface SandboxEgressProxyOptions {
  readonly grantRecheckMilliseconds: number;
  readonly networkAccess: NetworkAccessGate;
}

function parseDestinationPort(hostname: string, value: string): number {
  const port = Number(value);
  if (!/^[0-9]+$/u.test(value) || port < 1 || port > MAX_PORT) {
    throw new Error("AGENT_SANDBOX_EGRESS_PORT_FORBIDDEN: Port is not a valid TCP port");
  }
  // The network access gate decides the port of an IP address; a host name only reaches the web.
  if (!IP_LITERAL_HOST.test(hostname) && !ALLOWED_PORTS.has(port)) {
    throw new Error("AGENT_SANDBOX_EGRESS_PORT_FORBIDDEN: Only ports 80 and 443 are allowed");
  }
  return port;
}

async function resolveTarget(
  networkAccess: NetworkAccessGate,
  hostname: string,
  port: number,
  localAddress: string | undefined,
): Promise<ResolvedTarget> {
  if (IP_LITERAL_HOST.test(hostname)) {
    await networkAccess.authorize({ address: hostname, localAddress, port });
    return { address: hostname, family: 4, granted: true, hostname, port };
  }
  // Resolve outside host VPN fake-IP DNS, then pin the validated address for this connection.
  const publicAddress = await resolvePublicInternetAddress(hostname);
  return { ...publicAddress, granted: false, hostname, port };
}

// The sandbox sees why an IP destination was refused; every other refusal stays generic.
function refusalBody(error: unknown): string {
  return error instanceof NetworkAccessRefusal
    ? `${error.code}: ${error.clientMessage}\n`
    : "AGENT_SANDBOX_EGRESS_FORBIDDEN: Destination is not allowed\n";
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

function rejectSocket(socket: Socket, status: number, message: string, body = ""): void {
  const content = body ? `Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` : "";
  socket.end(`HTTP/1.1 ${status} ${message}\r\n${content}Connection: close\r\n\r\n${body}`);
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

export function createSandboxEgressProxy({ grantRecheckMilliseconds, networkAccess }: SandboxEgressProxyOptions) {
  const grantedConnections = createGrantedConnectionRegistry(networkAccess, grantRecheckMilliseconds);
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const targetUrl = new URL(incoming.url ?? "");
      if (targetUrl.protocol !== "http:" || targetUrl.username || targetUrl.password) {
        throw new Error("AGENT_SANDBOX_EGRESS_URL_FORBIDDEN: Only credential-free HTTP URLs are allowed");
      }
      const port = parseDestinationPort(targetUrl.hostname, targetUrl.port || "80");
      const target = await resolveTarget(networkAccess, targetUrl.hostname, port, incoming.socket.localAddress);
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
      if (target.granted) {
        const untrack = grantedConnections.track({
          address: target.address,
          close: () => {
            upstream.destroy();
            outgoing.destroy();
          },
          localAddress: incoming.socket.localAddress,
          port,
        });
        outgoing.once("close", untrack);
      }
      incoming.pipe(upstream);
    })().catch((error: unknown) => {
      writeEgressLog({
        code: "AGENT_SANDBOX_EGRESS_HTTP_REJECTED",
        errorMessage: errorMessage(error),
        host: urlHost(incoming.url),
      });
      if (!outgoing.headersSent) outgoing.writeHead(403);
      outgoing.end(refusalBody(error));
    });
  });

  server.on("connect", (request, clientSocket, initialData) => {
    let phase: ConnectPhase = "request";
    const clientUnavailable = guardClientSocket(clientSocket, () => phase);
    void (async () => {
      const match = /^\[?([^\]]+)\]?:([0-9]+)$/u.exec(request.url ?? "");
      if (!match) throw new Error("AGENT_SANDBOX_EGRESS_CONNECT_INVALID: Invalid CONNECT target");
      const port = parseDestinationPort(match[1]!, match[2]!);
      phase = "resolution";
      const target = await resolveTarget(networkAccess, match[1]!, port, clientSocket.localAddress);
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
      if (target.granted) {
        const untrack = grantedConnections.track({
          address: target.address,
          close: () => {
            upstream.destroy();
            clientSocket.destroy();
          },
          localAddress: clientSocket.localAddress,
          port,
        });
        upstream.once("close", untrack);
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
      rejectSocket(clientSocket, 403, "Forbidden", refusalBody(error));
    });
  });

  server.on("close", () => grantedConnections.stop());
  return server;
}
