/**
 * Sandbox egress proxy routing of IP destinations through the owner-approved access gate.
 *
 * Constructs covered:
 * - An IP destination on any port is forwarded, over plain HTTP and CONNECT, once the gate allows it.
 * - A refusal reaches the sandbox with its code, so the agent can tell what to ask the owner.
 * - The gate sees the proxy address the request arrived on, which identifies the caller's network.
 * - An open tunnel to an IP destination ends once the gate refuses it on a recheck.
 * - Host names keep the public-only rule and never consult the gate.
 * - With the real gate, unusual spellings of the server's own address are refused, never resolved.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNetworkAccessGate, NetworkAccessRefusal, type NetworkAccessGate } from "./network-access-gate.js";
import { createSandboxEgressProxy } from "./server.js";

let upstream: Server;
let proxy: Server;
let upstreamPort: number;
let proxyPort: number;
let gate: { authorize: ReturnType<typeof vi.fn> } & NetworkAccessGate;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function proxiedGet(url: string): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", path: url, port: proxyPort }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ body, status: response.statusCode ?? 0 }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function connectThroughProxy(target: string): Promise<{ head: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("utf8");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ head, socket });
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

describe("sandbox egress proxy IP destinations", () => {
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    upstream = createServer((incoming, outgoing) => outgoing.end(`home assistant at ${incoming.url}`));
    upstream.on("connect", (_request, socket: Socket) => {
      socket.write("HTTP/1.1 200 OK\r\n\r\n");
    });
    upstreamPort = await listen(upstream);
    gate = { authorize: vi.fn(async () => undefined) };
    proxy = createSandboxEgressProxy({ grantRecheckMilliseconds: 20, networkAccess: gate });
    proxyPort = await listen(proxy);
  });

  afterEach(async () => {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([close(proxy), close(upstream)]);
    vi.restoreAllMocks();
  });

  it("forwards plain HTTP to an approved address and port", async () => {
    const response = await proxiedGet(`http://127.0.0.1:${upstreamPort}/api/mcp?x=1`);

    expect(response).toEqual({ body: "home assistant at /api/mcp?x=1", status: 200 });
    expect(gate.authorize).toHaveBeenCalledWith({
      address: "127.0.0.1",
      localAddress: "127.0.0.1",
      port: upstreamPort,
    });
  });

  it("opens a CONNECT tunnel to an approved address and port", async () => {
    const tunnel = await connectThroughProxy(`127.0.0.1:${upstreamPort}`);

    expect(tunnel.head).toMatch(/^HTTP\/1\.1 200 Connection Established/u);
    tunnel.socket.destroy();
  });

  it("closes an open tunnel once its grant is revoked", async () => {
    const tunnel = await connectThroughProxy(`127.0.0.1:${upstreamPort}`);
    const closed = new Promise<void>((resolve) => tunnel.socket.once("close", () => resolve()));

    gate.authorize.mockRejectedValue(new NetworkAccessRefusal(
      "AGENT_SANDBOX_EGRESS_GRANT_REQUIRED",
      `127.0.0.1:${upstreamPort} requires network access approved by the owner`,
    ));

    await expect(closed).resolves.toBeUndefined();
  });

  it("tells the sandbox why an IP destination is refused", async () => {
    gate.authorize.mockRejectedValue(new NetworkAccessRefusal(
      "AGENT_SANDBOX_EGRESS_GRANT_REQUIRED",
      "100.91.171.16:8123 requires network access approved by the owner",
    ));

    const response = await proxiedGet("http://100.91.171.16:8123/api/");
    const tunnel = await connectThroughProxy("100.91.171.16:8123");

    expect(response.status).toBe(403);
    expect(response.body).toBe(
      "AGENT_SANDBOX_EGRESS_GRANT_REQUIRED: 100.91.171.16:8123 requires network access approved by the owner\n",
    );
    expect(tunnel.head).toMatch(/^HTTP\/1\.1 403 Forbidden/u);
    expect(tunnel.head).toContain("AGENT_SANDBOX_EGRESS_GRANT_REQUIRED");
    tunnel.socket.destroy();
  });

  it("keeps host names on ports 80 and 443 without asking the gate", async () => {
    const response = await proxiedGet("http://homeassistant.example:8123/");

    expect(response.status).toBe(403);
    expect(response.body).toBe("AGENT_SANDBOX_EGRESS_FORBIDDEN: Destination is not allowed\n");
    expect(gate.authorize).not.toHaveBeenCalled();
  });
});

describe("sandbox egress proxy with the real network access gate", () => {
  let directory: string;

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    directory = await mkdtemp(join(tmpdir(), "egress-real-gate-"));
    const projectionPath = join(directory, "grants.json");
    await writeFile(projectionPath, "{\"version\":1,\"grants\":[{\"address\":\"100.91.171.16\",\"port\":8123}]}\n");
    // The test connects over loopback, so loopback stands in for the trusted sandbox network here.
    proxy = createSandboxEgressProxy({
      grantRecheckMilliseconds: 60_000,
      networkAccess: createNetworkAccessGate({ attachedSubnets: () => [], projectionPath, trustedLocalAddress: "127.0.0.1" }),
    });
    proxyPort = await listen(proxy);
  });

  afterEach(async () => {
    proxy.closeAllConnections();
    await close(proxy);
    await rm(directory, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it.each(["2130706433:443", "127.0.0.1.:443", "0177.0.0.1:443", "127.0.0.1:22"])(
    "refuses the CONNECT target %s as permanently closed",
    async (target) => {
      const tunnel = await connectThroughProxy(target);

      expect(tunnel.head).toMatch(/^HTTP\/1\.1 403 Forbidden/u);
      expect(tunnel.head).toContain("AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN");
      tunnel.socket.destroy();
    },
  );

  it("refuses a plain HTTP request to the decimal spelling of loopback", async () => {
    const response = await proxiedGet("http://2130706433:8123/");

    expect(response.status).toBe(403);
    expect(response.body).toMatch(/^AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN: /u);
  });
});
