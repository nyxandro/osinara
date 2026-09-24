/**
 * Sandbox egress proxy log record tests.
 *
 * The log collector stores every output line as its own record and counts a line without a `code`
 * field that mentions an error as a runtime failure. A browser in the sandbox closes connections
 * all the time, so the proxy must describe each event in exactly one JSON line with a stable code,
 * and tell normal traffic apart from failures by that code.
 *
 * Constructs covered:
 * - A client closing its CONNECT socket is a routine record, any other client socket error is not.
 * - An upstream error on an established tunnel is routine; one before establishment is a failure.
 * - A rejected CONNECT target is a failure record carrying the rejection reason, not credentials.
 * - The plain HTTP path logs the destination host, never the URL with its credentials.
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
vi.mock("./public-dns-resolver.js", () => ({
  resolvePublicInternetAddress: vi.fn(async () => ({ address: "93.184.216.34", family: 4 })),
}));

const { createSandboxEgressProxy } = await import("./server.js");
const { SANDBOX_EGRESS_ROUTINE_CODES } = await import("./egress-log.js");

type LoggedLine = { stream: "error" | "info"; text: string };

let lines: LoggedLine[];

function loggedRecords(): Array<Record<string, unknown>> {
  return lines.map(({ text }) => {
    // One event, one physical line: a multi-line dump becomes several records in the collector.
    expect(text).not.toContain("\n");
    return JSON.parse(text) as Record<string, unknown>;
  });
}

function errnoError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function openTunnel(target: string) {
  const server = createSandboxEgressProxy();
  const client = new PassThrough() as unknown as Socket;
  const upstream = new PassThrough() as unknown as Socket;
  network.connect.mockReturnValue(upstream);
  server.emit("connect", { url: target }, client, Buffer.alloc(0));
  await settle();
  return { client, server, upstream };
}

describe("sandbox egress proxy log records", () => {
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "info").mockImplementation((text: string) => { lines.push({ stream: "info", text }); });
    vi.spyOn(console, "error").mockImplementation((text: string) => { lines.push({ stream: "error", text }); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    network.connect.mockReset();
    network.request.mockReset();
  });

  it.each(["EPIPE", "ECONNRESET"])(
    "records a client that closed its tunnel with %s as routine traffic",
    async (errorCode) => {
      const { client, server, upstream } = await openTunnel("example.com:443");
      upstream.emit("connect");

      client.emit("error", errnoError("client went away", errorCode));

      expect(loggedRecords()).toEqual([{
        code: "AGENT_SANDBOX_EGRESS_CLIENT_CLOSED",
        errorCode,
        errorName: "Error",
        phase: "tunnel",
      }]);
      expect(lines[0]!.stream).toBe("info");
      expect(SANDBOX_EGRESS_ROUTINE_CODES).toContain("AGENT_SANDBOX_EGRESS_CLIENT_CLOSED");
      server.removeAllListeners();
    },
  );

  it("records a client that gave up before the tunnel was established as routine traffic", async () => {
    const { client, server } = await openTunnel("example.com:443");

    client.emit("error", errnoError("client went away", "EPIPE"));

    expect(loggedRecords()).toEqual([{
      code: "AGENT_SANDBOX_EGRESS_CLIENT_CLOSED",
      errorCode: "EPIPE",
      errorName: "Error",
      phase: "connect",
    }]);
    server.removeAllListeners();
  });

  it("records any other client socket error as a failure", async () => {
    const { client, server } = await openTunnel("example.com:443");

    client.emit("error", errnoError("client socket broke", "ETIMEDOUT"));

    expect(loggedRecords()).toEqual([{
      code: "AGENT_SANDBOX_EGRESS_CLIENT_SOCKET_FAILED",
      errorCode: "ETIMEDOUT",
      errorName: "Error",
      phase: "connect",
    }]);
    expect(lines[0]!.stream).toBe("error");
    server.removeAllListeners();
  });

  it("records a site dropping an established tunnel as routine traffic", async () => {
    const { server, upstream } = await openTunnel("csp.example.net:443");
    upstream.emit("connect");

    upstream.emit("error", errnoError("read ECONNRESET", "ECONNRESET"));

    expect(loggedRecords()).toEqual([{
      code: "AGENT_SANDBOX_EGRESS_UPSTREAM_CLOSED",
      errorCode: "ECONNRESET",
      errorMessage: "read ECONNRESET",
      hostname: "csp.example.net",
      phase: "tunnel",
      port: 443,
    }]);
    expect(lines[0]!.stream).toBe("info");
    expect(SANDBOX_EGRESS_ROUTINE_CODES).toContain("AGENT_SANDBOX_EGRESS_UPSTREAM_CLOSED");
    server.removeAllListeners();
  });

  it("records a site that could not be reached as a failure", async () => {
    const { server, upstream } = await openTunnel("down.example.net:443");

    upstream.emit("error", errnoError("connect ECONNREFUSED 93.184.216.34:443", "ECONNREFUSED"));

    expect(loggedRecords()).toEqual([{
      code: "AGENT_SANDBOX_EGRESS_UPSTREAM_FAILED",
      errorCode: "ECONNREFUSED",
      errorMessage: "connect ECONNREFUSED 93.184.216.34:443",
      hostname: "down.example.net",
      phase: "connect",
      port: 443,
    }]);
    expect(lines[0]!.stream).toBe("error");
    expect(SANDBOX_EGRESS_ROUTINE_CODES).not.toContain("AGENT_SANDBOX_EGRESS_UPSTREAM_FAILED");
    server.removeAllListeners();
  });

  it("records a forbidden CONNECT port as a failure with its reason, without a stack", async () => {
    const { server } = await openTunnel("mtalk.google.com:5228");

    expect(loggedRecords()).toEqual([{
      code: "AGENT_SANDBOX_EGRESS_CONNECT_REJECTED",
      errorMessage: "AGENT_SANDBOX_EGRESS_PORT_FORBIDDEN: Only ports 80 and 443 are allowed",
      phase: "request",
      target: "mtalk.google.com:5228",
    }]);
    expect(lines[0]!.stream).toBe("error");
    expect(network.connect).not.toHaveBeenCalled();
    server.removeAllListeners();
  });

  it("logs a rejected CONNECT target without the credentials a client put into it", async () => {
    const { server } = await openTunnel("user:t0ken@mtalk.google.com:5228");

    expect(loggedRecords()).toEqual([{
      code: "AGENT_SANDBOX_EGRESS_CONNECT_REJECTED",
      errorMessage: "AGENT_SANDBOX_EGRESS_PORT_FORBIDDEN: Only ports 80 and 443 are allowed",
      phase: "request",
      target: "mtalk.google.com:5228",
    }]);
    server.removeAllListeners();
  });

  it("logs a rejected HTTP request by host only, never with the credentials in its URL", async () => {
    const server = createSandboxEgressProxy();
    const incoming = { headers: {}, method: "GET", url: "http://user:s3cret@example.com/path?token=t0ken" };
    const outgoing = { end: vi.fn(), headersSent: false, writeHead: vi.fn() };

    server.emit("request", incoming as unknown as IncomingMessage, outgoing as unknown as ServerResponse);
    await settle();

    expect(loggedRecords()).toEqual([{
      code: "AGENT_SANDBOX_EGRESS_HTTP_REJECTED",
      errorMessage: "AGENT_SANDBOX_EGRESS_URL_FORBIDDEN: Only credential-free HTTP URLs are allowed",
      host: "example.com",
    }]);
    expect(lines[0]!.text).not.toMatch(/s3cret|t0ken|user/u);
    expect(outgoing.writeHead).toHaveBeenCalledWith(403);
    server.removeAllListeners();
  });

  it("records a failed plain HTTP request as one failure line", async () => {
    const server = createSandboxEgressProxy();
    const upstream = Object.assign(new PassThrough(), { destroy: vi.fn() });
    network.request.mockReturnValue(upstream as unknown as ClientRequest);
    const incoming = Object.assign(new PassThrough(), {
      headers: {}, method: "GET", url: "http://example.com/page?token=t0ken",
    });
    const outgoing = Object.assign(new EventEmitter(), { end: vi.fn(), headersSent: false, writeHead: vi.fn() });

    server.emit("request", incoming as unknown as IncomingMessage, outgoing as unknown as ServerResponse);
    await settle();
    upstream.emit("error", errnoError("socket hang up", "ECONNRESET"));

    expect(loggedRecords()).toEqual([{
      code: "AGENT_SANDBOX_EGRESS_HTTP_FAILED",
      errorCode: "ECONNRESET",
      errorMessage: "socket hang up",
      hostname: "example.com",
      port: 80,
    }]);
    expect(lines[0]!.stream).toBe("error");
    expect(outgoing.writeHead).toHaveBeenCalledWith(502);
    server.removeAllListeners();
  });
});
