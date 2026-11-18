/**
 * Public-internet-only HTTP CONNECT proxy for trusted sandboxes.
 *
 * Exports:
 * - `bindTunnelLifecycle`: prevents either side of a CONNECT tunnel from becoming orphaned.
 * - `connectWithDeadline`: bounds TCP establishment without timing out an established idle tunnel.
 * - `SandboxEgressProxyOptions`: the owner-approved network access gate, how often open connections
 *   to IP destinations are rechecked against it, and the tally of sites opened and not reached.
 * - `createSandboxEgressProxy`: creates the internal proxy server.
 *
 * Security invariants:
 * - DNS is resolved at the proxy and the validated IP is pinned for the connection.
 * - A host name reaches only public destinations on ports 80 and 443.
 * - An IP address on any port is reached only when the network access gate allows it; a host name
 *   made of digits and dots is treated as an address and never resolved. An open connection to it
 *   is closed once a recheck finds the grant gone.
 * - With an upstream proxy bound, a host name in the Russian zones goes through it, always by the
 *   checked address and never by its name (#489); owner-granted addresses never go through it.
 * - Proxy credentials and hop-by-hop headers are never forwarded.
 * - Logs name the destination host, never a full URL: it may carry credentials or tokens.
 * - Neither side of a plain HTTP exchange is left orphaned, as with a CONNECT tunnel: a sandbox
 *   client that hangs up ends the request to the site at once, and a site that drops its response
 *   cuts the response to the sandbox. Either is routine traffic; only the proxy's own failure to
 *   reach or hear from the site is logged as a failure (#462).
 * - Each site counts once in the tally, when its connection is decided (#499): opened when the tunnel
 *   is established, or on the upstream route when the site's first byte comes back, or when a plain
 *   HTTP response begins; failed when that did not happen or DNS gave no answer for the name. A
 *   refusal by the proxy's own rules, a name that does not exist and an owner's device reached by its
 *   granted address are neither. The upstream proxy failing to open a tunnel counts as failed too, but
 *   is logged under a code of its own: it is our path broken, not a site, and stays an alert.
 */
import { createServer, request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";

import {
  type EgressLogRecord,
  SANDBOX_EGRESS_CLIENT_CLOSED_CODE,
  SANDBOX_EGRESS_HTTP_FAILED_CODE,
  SANDBOX_EGRESS_UPSTREAM_CLOSED_CODE,
  SANDBOX_EGRESS_UPSTREAM_FAILED_CODE,
  SANDBOX_EGRESS_UPSTREAM_PROXY_FAILED_CODE,
  writeEgressLog,
} from "./egress-log.js";
import type { EgressSiteMeter } from "./egress-site-meter.js";
import { filteredHeaders } from "./http-headers.js";
import { createGrantedConnectionRegistry } from "./granted-connection-registry.js";
import { NetworkAccessRefusal, type NetworkAccessGate } from "./network-access-gate.js";
import { EgressHostNotFound, EgressResolutionFailed, resolvePublicInternetAddress } from "./public-dns-resolver.js";
import { openUpstreamTunnel, routedThroughUpstream, type UpstreamProxy, watchTunnelAnswer } from "./upstream-proxy.js";

const ALLOWED_PORTS = new Set([80, 443]);
const MAX_PORT = 65_535;
const IP_LITERAL_HOST = /^[0-9.]+$/u;
const CONNECT_TIMEOUT_MS = 15_000;
// How a client closing its side of the connection surfaces on the proxy socket.
const CLIENT_CLOSED_ERROR_CODES = new Set(["ECONNRESET", "EPIPE"]);
// A device of the owner's reached by its granted address is not a site (#499).
const NOT_A_SITE: EgressSiteMeter = { failed: () => undefined, opened: () => undefined };

interface ResolvedTarget {
  address: string;
  family: 4;
  /** The network access gate allowed it, so the connection is rechecked while it stays open. */
  granted: boolean;
  hostname: string;
  port: number;
  /** The upstream proxy this destination goes through (#489), or null when it goes straight from here. */
  upstream: UpstreamProxy | null;
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
  /** Where sites in the Russian zones go; without it every destination is direct (#489). */
  readonly upstreamProxy?: UpstreamProxy | null;
  /** Feeds the alert on a day without a single opened site (#499). */
  readonly siteMeter: EgressSiteMeter;
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
  upstreamProxy: UpstreamProxy | null,
  hostname: string,
  port: number,
  localAddress: string | undefined,
): Promise<ResolvedTarget> {
  if (IP_LITERAL_HOST.test(hostname)) {
    // An owner-granted address is a device of theirs: it is never sent anywhere but straight to it.
    await networkAccess.authorize({ address: hostname, localAddress, port });
    return { address: hostname, family: 4, granted: true, hostname, port, upstream: null };
  }
  // Resolve outside host VPN fake-IP DNS, then pin the validated address for this connection.
  const publicAddress = await resolvePublicInternetAddress(hostname);
  const upstream = upstreamProxy !== null && routedThroughUpstream(hostname) ? upstreamProxy : null;
  return { ...publicAddress, granted: false, hostname, port, upstream };
}

/** The route field of a log record: absent for the direct route, so its records stay as they were. */
function routeField(target: ResolvedTarget): { via?: "upstream" } {
  return target.upstream === null ? {} : { via: "upstream" };
}

// The sandbox sees why an IP destination was refused and that a name does not exist, which is
// public knowledge and stops a retry of a mistyped address; every other refusal stays generic.
function refusalBody(error: unknown): string {
  if (error instanceof NetworkAccessRefusal) return `${error.code}: ${error.clientMessage}\n`;
  if (error instanceof EgressHostNotFound) return `${error.message}; check the spelling of the address\n`;
  return "AGENT_SANDBOX_EGRESS_FORBIDDEN: Destination is not allowed\n";
}

// Clients hide the body of a refused CONNECT and undici keeps only its status code, so a name that
// does not resolve gets a status of its own: web_fetch tells the model the address does not exist.
function refusalStatus(error: unknown): { readonly code: number; readonly text: string } {
  return error instanceof EgressHostNotFound ? { code: 404, text: "Host Not Found" } : { code: 403, text: "Forbidden" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A refusal before any connection: a name that does not exist is routine, DNS that gave no answer is a
// site that did not open, and anything else is the proxy's own refusal under the caller's code.
function refusalRecord(error: unknown, rejectedCode: string, where: Readonly<Record<string, string | null>>): EgressLogRecord {
  if (error instanceof EgressHostNotFound || error instanceof EgressResolutionFailed) {
    return { code: error.code, dnsCode: error.dnsCode, ...where };
  }
  return { code: rejectedCode, errorMessage: errorMessage(error), ...where };
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

export function createSandboxEgressProxy(options: SandboxEgressProxyOptions) {
  const { grantRecheckMilliseconds, networkAccess, siteMeter } = options;
  const upstreamProxy = options.upstreamProxy ?? null;
  const grantedConnections = createGrantedConnectionRegistry(networkAccess, grantRecheckMilliseconds);
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const targetUrl = new URL(incoming.url ?? "");
      if (targetUrl.protocol !== "http:" || targetUrl.username || targetUrl.password) {
        throw new Error("AGENT_SANDBOX_EGRESS_URL_FORBIDDEN: Only credential-free HTTP URLs are allowed");
      }
      const port = parseDestinationPort(targetUrl.hostname, targetUrl.port || "80");
      const target = await resolveTarget(networkAccess, upstreamProxy, targetUrl.hostname, port, incoming.socket.localAddress);
      // A client gone while the destination was being decided closed before any listener below
      // existed: nothing is opened for it, and nothing tracked under an owner's grant.
      if (outgoing.destroyed) return;
      const site = target.granted ? NOT_A_SITE : siteMeter;
      // Which side ended an unfinished exchange first; the close of the other side that follows is
      // its echo, not a second event (#462).
      let endedBy: "client" | "failure" | "revocation" | "site" | null = null;
      let responseStarted = false;
      let timedOut = false;
      // The site ended a connection it had already answered on: its own decision, as on an
      // established tunnel, so routine traffic whether it closed or reset the connection.
      const siteEnded = () => {
        endedBy = "site";
        writeEgressLog({ code: SANDBOX_EGRESS_UPSTREAM_CLOSED_CODE, hostname: target.hostname, phase: "response", port, ...routeField(target) });
        outgoing.destroy();
      };
      const clientClosed = (phase: "request" | "response") => {
        endedBy = "client";
        writeEgressLog({ code: SANDBOX_EGRESS_CLIENT_CLOSED_CODE, hostname: target.hostname, phase, port, ...routeField(target) });
      };
      const failed = (error: NodeJS.ErrnoException, code: string) => {
        endedBy = "failure";
        // A site gone silent mid-response had already opened.
        if (!responseStarted) site.failed();
        writeEgressLog({
          code,
          errorCode: error.code ?? null,
          errorMessage: error.message,
          hostname: target.hostname,
          port,
          ...routeField(target),
        });
        // Text appended to a body already under way would corrupt it: a started response is cut.
        if (outgoing.headersSent) {
          outgoing.destroy();
          return;
        }
        outgoing.writeHead(502);
        outgoing.end("AGENT_SANDBOX_EGRESS_FAILED: Public destination request failed\n");
      };
      // Through the upstream proxy plain HTTP gets a tunnel of its own to the checked address, and the
      // request then goes as the site expects it, with its own name in Host. An absolute-form request
      // would reach the site with the address in Host (a proxy must replace it, RFC 9112 §3.2.2), and
      // the host Xray closes such connections after each answer while announcing keep-alive (#489).
      let tunnel: Socket | null = null;
      if (target.upstream !== null) {
        // A client that leaves while the tunnel is being opened lets go of the upstream proxy at once.
        const clientGone = new AbortController();
        const abandon = () => clientGone.abort();
        outgoing.once("close", abandon);
        try {
          tunnel = await openUpstreamTunnel(target.upstream, target.address, target.port, CONNECT_TIMEOUT_MS, clientGone.signal);
        } catch (error) {
          if (outgoing.destroyed) clientClosed("request");
          else failed(error as NodeJS.ErrnoException, SANDBOX_EGRESS_UPSTREAM_PROXY_FAILED_CODE);
          return;
        } finally {
          outgoing.off("close", abandon);
        }
        if (outgoing.destroyed) {
          tunnel.destroy();
          clientClosed("request");
          return;
        }
      }
      const opened = tunnel;
      // A connection made by hand does not get the request's idle limit; the tunnel takes it here.
      const destination = opened === null
        ? { family: target.family, host: target.address, port: target.port }
        : { createConnection: () => opened.setTimeout(CONNECT_TIMEOUT_MS) };
      const upstream = httpRequest({
        ...destination,
        headers: { ...filteredHeaders(incoming.headers), host: targetUrl.host },
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: incoming.method,
        timeout: CONNECT_TIMEOUT_MS,
      }, (upstreamResponse) => {
        responseStarted = true;
        site.opened();
        outgoing.writeHead(
          upstreamResponse.statusCode ?? 502,
          filteredHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(outgoing);
        // A site dropping its response halfway ends it without `end`, and the pipe would leave the
        // sandbox waiting for the rest: its response is cut too, so the client sees a broken transfer.
        upstreamResponse.once("close", () => {
          if (upstreamResponse.complete || endedBy !== null || timedOut) return;
          siteEnded();
        });
      });
      upstream.on("timeout", () => {
        timedOut = true;
        upstream.destroy(new Error("AGENT_SANDBOX_EGRESS_TIMEOUT: Upstream connection timed out"));
      });
      upstream.on("error", (error: NodeJS.ErrnoException) => {
        if (endedBy !== null) return;
        // A reset in the middle of the body; a site that went silent stays a failure of the path.
        if (responseStarted && !timedOut) {
          siteEnded();
          return;
        }
        failed(error, SANDBOX_EGRESS_HTTP_FAILED_CODE);
      });
      // A sandbox client that hangs up before the whole response came, as apt does with a package it
      // cannot store, leaves nobody to read the site. The request ends now, recorded as the client's
      // own close, instead of idling into a timeout blamed on the site (#462).
      outgoing.once("close", () => {
        if (outgoing.writableFinished || endedBy !== null) return;
        clientClosed(responseStarted ? "response" : "request");
        upstream.destroy();
      });
      if (target.granted) {
        const untrack = grantedConnections.track({
          address: target.address,
          close: () => {
            // The registry records the revocation itself.
            endedBy ??= "revocation";
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
      if (error instanceof EgressResolutionFailed) siteMeter.failed();
      writeEgressLog(refusalRecord(error, "AGENT_SANDBOX_EGRESS_HTTP_REJECTED", { host: urlHost(incoming.url) }));
      const status = refusalStatus(error);
      if (!outgoing.headersSent) outgoing.writeHead(status.code, status.text);
      outgoing.end(refusalBody(error));
    });
  });

  server.on("connect", (request, connectSocket, initialData) => {
    // Typed as a Duplex, but Node passes a net.Socket unless the server was built with another socket
    // type (node:http, event 'connect'); this server never is.
    const clientSocket = connectSocket as Socket;
    let phase: ConnectPhase = "request";
    const clientUnavailable = guardClientSocket(clientSocket, () => phase);
    void (async () => {
      const match = /^\[?([^\]]+)\]?:([0-9]+)$/u.exec(request.url ?? "");
      if (!match) throw new Error("AGENT_SANDBOX_EGRESS_CONNECT_INVALID: Invalid CONNECT target");
      const port = parseDestinationPort(match[1]!, match[2]!);
      phase = "resolution";
      const target = await resolveTarget(networkAccess, upstreamProxy, match[1]!, port, clientSocket.localAddress);
      if (clientUnavailable()) return;
      phase = "connect";
      const open = (socket: Socket) => {
        phase = "tunnel";
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (initialData.byteLength > 0) socket.write(initialData);
        socket.pipe(clientSocket);
        clientSocket.pipe(socket);
      };
      const site = target.granted ? NOT_A_SITE : siteMeter;
      // `byUpstreamProxy`: the host's upstream proxy, not the site, failed to open the tunnel.
      const failed = (error: NodeJS.ErrnoException, byUpstreamProxy = false) => {
        // A site that drops an established tunnel had already opened.
        if (phase !== "tunnel") site.failed();
        const failureCode = byUpstreamProxy ? SANDBOX_EGRESS_UPSTREAM_PROXY_FAILED_CODE : SANDBOX_EGRESS_UPSTREAM_FAILED_CODE;
        writeEgressLog({
          code: phase === "tunnel" ? SANDBOX_EGRESS_UPSTREAM_CLOSED_CODE : failureCode,
          errorCode: error.code ?? null,
          errorMessage: error.message,
          hostname: target.hostname,
          phase,
          port,
          ...routeField(target),
        });
        rejectSocket(clientSocket, 502, "Bad Gateway");
      };
      if (target.upstream !== null) {
        // A client that leaves while the tunnel is being opened lets go of the upstream proxy at once;
        // a client that only half-closes before its tunnel is open has left too.
        const clientGone = new AbortController();
        const abandon = () => clientGone.abort();
        clientSocket.once("end", abandon);
        clientSocket.once("close", abandon);
        let tunnel: Socket;
        try {
          tunnel = await openUpstreamTunnel(target.upstream, target.address, port, CONNECT_TIMEOUT_MS, clientGone.signal);
        } catch (error) {
          // A half-closed client socket stays open until closed here.
          if (clientGone.signal.aborted || clientUnavailable()) clientSocket.destroy();
          else failed(error as NodeJS.ErrnoException, true);
          return;
        } finally {
          clientSocket.off("end", abandon);
          clientSocket.off("close", abandon);
        }
        bindTunnelLifecycle(clientSocket, tunnel);
        if (clientGone.signal.aborted || clientUnavailable()) {
          tunnel.destroy();
          return;
        }
        // The tunnel already answered 200 to the client: an error is recorded, never written into it,
        // where it would read as the destination's own answer (#489).
        watchTunnelAnswer({
          answerTimeoutMilliseconds: CONNECT_TIMEOUT_MS,
          asked: initialData.byteLength > 0,
          client: clientSocket,
          onAnswer: () => site.opened(),
          onNoAnswer: (errorCode, errorMessage) => {
            site.failed();
            writeEgressLog({
              code: SANDBOX_EGRESS_UPSTREAM_FAILED_CODE,
              errorCode,
              errorMessage,
              hostname: target.hostname,
              phase,
              port,
              via: "upstream",
            });
          },
          onTunnelError: (error) => writeEgressLog({
            code: SANDBOX_EGRESS_UPSTREAM_CLOSED_CODE,
            errorCode: error.code ?? null,
            errorMessage: error.message,
            hostname: target.hostname,
            phase,
            port,
            via: "upstream",
          }),
          tunnel,
        });
        open(tunnel);
        return;
      }
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
        site.opened();
        open(upstream);
      });
      upstream.once("error", failed);
    })().catch((error: unknown) => {
      if (error instanceof EgressResolutionFailed) siteMeter.failed();
      writeEgressLog(refusalRecord(error, "AGENT_SANDBOX_EGRESS_CONNECT_REJECTED", { phase, target: connectTargetForLog(request.url) }));
      const status = refusalStatus(error);
      rejectSocket(clientSocket, status.code, status.text, refusalBody(error));
    });
  });

  server.on("close", () => grantedConnections.stop());
  return server;
}
