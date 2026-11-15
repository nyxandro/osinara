/**
 * Failures on the upstream route of the sandbox egress proxy, over real local sockets (#489).
 *
 * Constructs covered:
 * - An upstream proxy that refuses or cannot be reached answers the sandbox with 502 and is logged as
 *   the upstream proxy's own failure, which the burst alert counts: no site was even asked (#499).
 * - Xray answers 200 before it dials, so a destination its node cannot reach shows as a tunnel that
 *   closes or resets before a byte came back: one failure record, and nothing written into a tunnel
 *   the sandbox already holds open, which would read as the site's own answer.
 * - A tunnel that ends after the site answered, or before the client asked anything, is ordinary
 *   traffic and leaves no failure.
 * - A sandbox client that leaves while the upstream proxy is still opening its tunnel releases that
 *   tunnel at once: no failure is blamed on the path for a client that is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SANDBOX_EGRESS_SITE_FAILURE_CODES } from "./egress-log.js";

import {
  answerOnceSite,
  captureLogs,
  closeServers,
  egressProxy,
  type Logged,
  pendingRequest,
  plainGet,
  released,
  settle,
  tunnel,
  unusedPort,
  upstreamProxy,
  within,
} from "./upstream-test-servers.js";

vi.mock("./public-dns-resolver.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./public-dns-resolver.js")>(),
  // Every name resolves to this machine, where the tests' servers listen.
  resolvePublicInternetAddress: vi.fn(async () => ({ address: "127.0.0.1", family: 4 as const })),
}));

let logged: Logged[];

describe("failures on the upstream route of the sandbox egress proxy (#489)", () => {
  beforeEach(() => {
    logged = captureLogs();
  });

  afterEach(async () => {
    await closeServers();
  });

  it("answers 502 and logs the failed upstream connection when the upstream proxy refuses", async () => {
    const upstream = await upstreamProxy({}, "refuse");
    const proxy = await egressProxy(upstream.port);

    const { status } = await tunnel(proxy, "shop.example.ru:443");

    expect(status).toBe(502);
    expect(logged).toEqual([{
      record: expect.objectContaining({
        code: "AGENT_SANDBOX_EGRESS_UPSTREAM_PROXY_FAILED",
        errorMessage: expect.stringContaining("AGENT_SANDBOX_EGRESS_UPSTREAM_REFUSED"),
        hostname: "shop.example.ru",
        phase: "connect",
        port: 443,
        via: "upstream",
      }),
      stream: "error",
    }]);
  });

  it("answers 502 for both kinds of request when the upstream proxy cannot be reached", async () => {
    const proxy = await egressProxy(await unusedPort());

    const { status } = await tunnel(proxy, "shop.example.ru:443");
    const plain = await plainGet(proxy, "http://shop.example.ru/");

    expect(status).toBe(502);
    expect(plain.status).toBe(502);
    expect(logged.map(({ record }) => [record.code, record.errorCode, record.via])).toEqual([
      ["AGENT_SANDBOX_EGRESS_UPSTREAM_PROXY_FAILED", "ECONNREFUSED", "upstream"],
      ["AGENT_SANDBOX_EGRESS_UPSTREAM_PROXY_FAILED", "ECONNREFUSED", "upstream"],
    ]);
    // The host's Xray inbound gone is our own path broken, not a site: it must stay loud.
    expect(SANDBOX_EGRESS_SITE_FAILURE_CODES).not.toContain("AGENT_SANDBOX_EGRESS_UPSTREAM_PROXY_FAILED");
  });

  it.each([
    ["closed", "silent", null],
    ["reset", "reset", expect.stringMatching(/^(ECONNRESET|EPIPE)$/u)],
  ] as const)("logs one failure for a tunnel %s before the site sent anything and writes nothing into it", async (
    _case,
    behaviour,
    errorCode,
  ) => {
    const upstream = await upstreamProxy({}, behaviour);
    const proxy = await egressProxy(upstream.port);

    const { socket, status } = await tunnel(proxy, "shop.example.ru:443");
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write("client hello");
    await within(closed, "the tunnel closing");
    await settle();

    // Xray says 200 before it dials: the sandbox sees an open tunnel that ends without an answer.
    expect(status).toBe(200);
    expect(Buffer.concat(received).toString()).toBe("");
    expect(logged).toEqual([{
      record: expect.objectContaining({
        code: "AGENT_SANDBOX_EGRESS_UPSTREAM_FAILED",
        errorCode,
        errorMessage: expect.stringContaining("AGENT_SANDBOX_EGRESS_UPSTREAM_NO_ANSWER"),
        hostname: "shop.example.ru",
        phase: "tunnel",
        port: 443,
        via: "upstream",
      }),
      stream: "error",
    }]);
  });

  it("logs no failure for a tunnel the site closed after its answer", async () => {
    const upstream = await upstreamProxy({ tls: await answerOnceSite() });
    const proxy = await egressProxy(upstream.port);

    const { socket } = await tunnel(proxy, "shop.example.ru:443");
    const answer = new Promise<string>((resolve) => socket.once("data", (chunk: Buffer) => resolve(chunk.toString())));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write("client hello");
    await expect(within(answer, "the site's answer")).resolves.toBe("answer");
    await within(closed, "the tunnel closing");
    await settle();

    expect(logged.filter(({ stream }) => stream === "error")).toEqual([]);
  });

  it("logs no failure for a client that leaves its tunnel without asking anything", async () => {
    const upstream = await upstreamProxy({}, "silent");
    const proxy = await egressProxy(upstream.port);

    const { socket } = await tunnel(proxy, "shop.example.ru:443");
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(logged.filter(({ stream }) => stream === "error")).toEqual([]);
  });

  it("releases the upstream proxy at once when a tunnel's client leaves before the tunnel opened", async () => {
    const upstream = await upstreamProxy({}, "stall");
    const proxy = await egressProxy(upstream.port);

    const client = pendingRequest(proxy, "CONNECT", "shop.example.ru:443");
    const asked = await within(upstream.stalled, "the upstream proxy being asked for the tunnel");
    const upstreamReleased = released(asked);
    client.destroy();
    await within(upstreamReleased, "the upstream proxy being released");
    await settle();

    expect(logged.filter(({ stream }) => stream === "error")).toEqual([]);
  });

  it("releases the upstream proxy and records the client's own close when a plain HTTP client leaves first", async () => {
    const upstream = await upstreamProxy({}, "stall");
    const proxy = await egressProxy(upstream.port);

    const client = pendingRequest(proxy, "GET", "http://shop.example.ru/");
    const asked = await within(upstream.stalled, "the upstream proxy being asked for the tunnel");
    const upstreamReleased = released(asked);
    client.destroy();
    await within(upstreamReleased, "the upstream proxy being released");
    await settle();

    expect(logged).toEqual([{
      record: expect.objectContaining({
        code: "AGENT_SANDBOX_EGRESS_CLIENT_CLOSED",
        hostname: "shop.example.ru",
        phase: "request",
        port: 80,
        via: "upstream",
      }),
      stream: "info",
    }]);
  });
});
