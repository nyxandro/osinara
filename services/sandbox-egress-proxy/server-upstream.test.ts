/**
 * Which route the sandbox egress proxy takes for a destination, over real local sockets (#489).
 *
 * Constructs covered:
 * - A destination in the Russian zones is tunnelled through the upstream proxy by the address the
 *   proxy itself resolved and checked, never by its name: the public-address guarantee stays here.
 * - Plain HTTP to such a site goes through a tunnel of its own too, so the site gets its own name in
 *   Host and every request a fresh connection; requests one after another all succeed, and a slow site
 *   is waited for as long as on the direct route.
 * - Any other destination, every owner-granted address, and every destination without an upstream
 *   binding stay direct.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureLogs,
  closeServers,
  DEADLINE_MILLISECONDS,
  echoSite,
  egressProxy,
  httpSite,
  plainGet,
  tunnel,
  upstreamProxy,
  within,
} from "./upstream-test-servers.js";

vi.mock("./public-dns-resolver.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./public-dns-resolver.js")>(),
  // Every name resolves to this machine, where the tests' servers listen.
  resolvePublicInternetAddress: vi.fn(async () => ({ address: "127.0.0.1", family: 4 as const })),
}));

// Longer than the 5 s a Node HTTP connection idles by default, shorter than the 15 s of the direct route.
const SLOW_SITE_MILLISECONDS = 5_500;

describe("route of a destination through the sandbox egress proxy (#489)", () => {
  beforeEach(() => {
    captureLogs();
  });

  afterEach(async () => {
    await closeServers();
  });

  it("tunnels a .ru site through the upstream proxy by the address it checked", async () => {
    const upstream = await upstreamProxy({ tls: await echoSite() });
    const proxy = await egressProxy(upstream.port);

    const { socket, status } = await tunnel(proxy, "shop.example.ru:443");
    const echoed = new Promise<string>((resolve) => socket.once("data", (chunk: Buffer) => resolve(chunk.toString())));
    socket.write("ping");

    expect(status).toBe(200);
    await expect(within(echoed, "the echo through the tunnel")).resolves.toBe("ping");
    expect(upstream.tunnels).toEqual(["127.0.0.1:443"]);
    socket.destroy();
  });

  it("sends plain HTTP for a .ru site through a tunnel of its own, with the site's name in Host", async () => {
    const site = await httpSite();
    const upstream = await upstreamProxy({ http: site.port });
    const proxy = await egressProxy(upstream.port);

    const answer = await plainGet(proxy, "http://shop.example.ru/catalog?id=7");

    expect(answer).toEqual({ body: "страница сайта", status: 200 });
    expect(upstream.tunnels).toEqual(["127.0.0.1:80"]);
    expect(site.seen).toEqual([{ host: "shop.example.ru", url: "/catalog?id=7" }]);
  });

  it("answers plain HTTP requests one after another, each through its own tunnel", async () => {
    const site = await httpSite();
    const upstream = await upstreamProxy({ http: site.port });
    const proxy = await egressProxy(upstream.port);

    for (let index = 0; index < 4; index += 1) {
      await expect(plainGet(proxy, `http://mirror.example.ru/pool/${index}.deb`)).resolves.toMatchObject({ status: 200 });
    }

    expect(upstream.tunnels).toHaveLength(4);
    expect(site.seen.map(({ url }) => url)).toEqual(["/pool/0.deb", "/pool/1.deb", "/pool/2.deb", "/pool/3.deb"]);
  });

  it("waits for a slow plain HTTP site through the upstream proxy as long as on the direct route", async () => {
    const site = await httpSite(SLOW_SITE_MILLISECONDS);
    const upstream = await upstreamProxy({ http: site.port });
    const proxy = await egressProxy(upstream.port);

    const answer = await plainGet(proxy, "http://slow.example.ru/", SLOW_SITE_MILLISECONDS + DEADLINE_MILLISECONDS);

    expect(answer).toEqual({ body: "страница сайта", status: 200 });
  }, SLOW_SITE_MILLISECONDS + 2 * DEADLINE_MILLISECONDS);

  it("keeps a site outside the Russian zones direct", async () => {
    const upstream = await upstreamProxy({ tls: await echoSite() });
    const proxy = await egressProxy(upstream.port);

    // The direct attempt reaches whatever listens on this machine's port 443, if anything: only the
    // route matters here, not its outcome.
    const { socket } = await tunnel(proxy, "shop.example.com:443");
    socket.destroy();

    expect(upstream.tunnels).toEqual([]);
  });

  it("keeps an owner-granted address direct", async () => {
    const echo = await echoSite();
    const upstream = await upstreamProxy({ tls: echo });
    const proxy = await egressProxy(upstream.port);

    const { socket, status } = await tunnel(proxy, `127.0.0.1:${echo}`);
    socket.destroy();

    expect(status).toBe(200);
    expect(upstream.tunnels).toEqual([]);
  });

  it("goes direct for every site when no upstream proxy is bound", async () => {
    const upstream = await upstreamProxy({ tls: await echoSite() });
    const proxy = await egressProxy(null);

    const { socket } = await tunnel(proxy, "shop.example.ru:443");
    socket.destroy();

    expect(upstream.tunnels).toEqual([]);
  });
});
