/**
 * What the egress proxy counts on the upstream route for Russian sites (#489, #499), over real local
 * sockets.
 *
 * Xray answers a tunnel with 200 before it dials, so on this route a site has opened only when its
 * first byte came back; a tunnel that ended or stayed silent after the client asked is a site that
 * could not be reached. A tunnel the client left without asking says nothing either way.
 *
 * Constructs covered:
 * - A tunnel the site answered through counts as opened, and a plain HTTP page through the route too.
 * - A tunnel that ended without an answer, on either kind of request, and an upstream proxy that
 *   refused, count as failed: no site opened.
 * - A client that left its tunnel without asking anything is not counted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureLogs,
  closeServers,
  echoSite,
  httpSite,
  measuredEgressProxy,
  plainGet,
  settle,
  tunnel,
  upstreamProxy,
  within,
} from "./upstream-test-servers.js";

vi.mock("./public-dns-resolver.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./public-dns-resolver.js")>(),
  // Every name resolves to this machine, where the tests' servers listen.
  resolvePublicInternetAddress: vi.fn(async () => ({ address: "127.0.0.1", family: 4 as const })),
}));

describe("sites counted on the upstream route of the sandbox egress proxy", () => {
  beforeEach(() => {
    captureLogs();
  });

  afterEach(async () => {
    await closeServers();
  });

  it("counts a tunnel the site answered through as opened", async () => {
    const upstream = await upstreamProxy({ tls: await echoSite() });
    const proxy = await measuredEgressProxy(upstream.port);

    const { socket } = await tunnel(proxy.port, "shop.example.ru:443");
    const answer = new Promise<string>((resolve) => socket.once("data", (chunk: Buffer) => resolve(chunk.toString())));
    socket.write("client hello");
    await within(answer, "the site's answer");
    socket.destroy();
    await settle();

    expect(proxy.sites).toEqual({ failed: 0, opened: 1 });
  });

  it("counts a plain HTTP page through the route as opened", async () => {
    const site = await httpSite();
    const upstream = await upstreamProxy({ http: site.port });
    const proxy = await measuredEgressProxy(upstream.port);

    const page = await plainGet(proxy.port, "http://shop.example.ru/");

    expect(page.status).toBe(200);
    expect(proxy.sites).toEqual({ failed: 0, opened: 1 });
  });

  it("counts a tunnel that ended before the site sent anything as failed", async () => {
    const upstream = await upstreamProxy({}, "silent");
    const proxy = await measuredEgressProxy(upstream.port);

    const { socket } = await tunnel(proxy.port, "shop.example.ru:443");
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write("client hello");
    await within(closed, "the tunnel closing");
    await settle();

    expect(proxy.sites).toEqual({ failed: 1, opened: 0 });
  });

  it("counts a plain HTTP request whose tunnel brought no response as failed", async () => {
    const upstream = await upstreamProxy({}, "silent");
    const proxy = await measuredEgressProxy(upstream.port);

    const page = await plainGet(proxy.port, "http://shop.example.ru/");
    await settle();

    expect(page.status).toBe(502);
    expect(proxy.sites).toEqual({ failed: 1, opened: 0 });
  });

  it("counts an upstream proxy that refused the tunnel as failed", async () => {
    const upstream = await upstreamProxy({}, "refuse");
    const proxy = await measuredEgressProxy(upstream.port);

    const { status } = await tunnel(proxy.port, "shop.example.ru:443");
    await settle();

    expect(status).toBe(502);
    expect(proxy.sites).toEqual({ failed: 1, opened: 0 });
  });

  it("does not count a tunnel its client left without asking anything", async () => {
    const upstream = await upstreamProxy({}, "silent");
    const proxy = await measuredEgressProxy(upstream.port);

    const { socket } = await tunnel(proxy.port, "shop.example.ru:443");
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(proxy.sites).toEqual({ failed: 0, opened: 0 });
  });
});
