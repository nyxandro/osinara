import { afterEach, describe, expect, it, vi } from "vitest";

import { HEALTH_ROUTE, startRuntimeServer, type RuntimeRoute, type RuntimeServer } from "./server.js";

let server: RuntimeServer | undefined;

async function serve(routes: RuntimeRoute[]) {
  server = await startRuntimeServer({ host: "127.0.0.1", port: 0, routes });
  return `http://127.0.0.1:${server.port}`;
}

describe("runtime HTTP server", () => {
  afterEach(async () => {
    await server?.close(1_000);
    server = undefined;
    vi.restoreAllMocks();
  });

  it("answers the health check the way Docker and the deploy controller expect", async () => {
    const base = await serve([]);

    const health = await fetch(`${base}${HEALTH_ROUTE}`);
    const head = await fetch(`${base}${HEALTH_ROUTE}`, { method: "HEAD" });

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, status: "ready" });
    expect(head.status).toBe(200);
  });

  it("hands a route the request with its headers and body, and returns the route's response", async () => {
    const seen: Array<{ body: string; secret: string | null; url: string }> = [];
    const base = await serve([{
      method: "POST",
      path: "/v1/telegram",
      async handle(request) {
        seen.push({ body: await request.text(), secret: request.headers.get("x-telegram-bot-api-secret-token"), url: new URL(request.url).pathname });
        return new Response("ok", { headers: { "x-osinara-runtime-admission": "1" } });
      },
    }]);

    const response = await fetch(`${base}/v1/telegram`, { body: '{"update_id":1}', headers: { "x-telegram-bot-api-secret-token": "s" }, method: "POST" });

    expect(await response.text()).toBe("ok");
    expect(response.headers.get("x-osinara-runtime-admission")).toBe("1");
    expect(seen).toEqual([{ body: '{"update_id":1}', secret: "s", url: "/v1/telegram" }]);
  });

  it("serves the previous addresses as the current ones until Telegram, Google and the deploy tools move over", async () => {
    const seen: string[] = [];
    const base = await serve([{ method: "POST", path: "/v1/telegram", async handle(request) { seen.push(new URL(request.url).pathname); return new Response("ok"); } }]);

    expect((await fetch(`${base}/eve/v1/telegram`, { method: "POST" })).status).toBe(200);
    expect((await fetch(`${base}/eve/v1/health`)).status).toBe(200);
    expect(seen).toEqual(["/v1/telegram"]);
  });

  it("answers 404 for an unknown address or method, and 500 with one log line when a route fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const base = await serve([{ method: "POST", path: "/broken", handle: async () => { throw new Error("boom"); } }]);

    expect((await fetch(`${base}/v1/sessions`)).status).toBe(404);
    expect((await fetch(`${base}/broken`)).status).toBe(404);
    expect((await fetch(`${base}/broken`, { method: "POST" })).status).toBe(500);
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { code: "AGENT_HTTP_ROUTE_FAILED", error: "boom", method: "POST", path: "/broken" },
    ]);
  });

  it("waits on close for work a route left running after its response, but no longer than the grace", async () => {
    let finished = false;
    const base = await serve([
      {
        method: "POST",
        path: "/work",
        async handle(_request, context) {
          context.waitUntil(new Promise((resolve) => setTimeout(() => { finished = true; resolve(null); }, 100)));
          return new Response("ok");
        },
      },
      {
        method: "POST",
        path: "/endless",
        async handle(_request, context) {
          context.waitUntil(new Promise(() => {}));
          return new Response("ok");
        },
      },
    ]);
    await fetch(`${base}/work`, { method: "POST" });
    await fetch(`${base}/endless`, { method: "POST" });

    const started = Date.now();
    await server!.close(400);
    server = undefined;

    expect(finished).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses two routes on one address", async () => {
    const route: RuntimeRoute = { method: "POST", path: "/x", handle: async () => new Response("ok") };
    await expect(startRuntimeServer({ host: "127.0.0.1", port: 0, routes: [route, route] })).rejects.toThrow("AGENT_HTTP_ROUTE_DUPLICATE");
  });
});
