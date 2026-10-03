/**
 * The agent's HTTP server: the routes channels declare, plus the health check.
 *
 * Exports:
 * - `startRuntimeServer`: listens on the given port; `close` stops taking requests and waits a
 *   bounded time for answered requests' background work.
 * - `RuntimeRoute`, `RouteContext`: a route and what its handler may do after answering.
 * - `HEALTH_ROUTE`: `/v1/health`, the address Docker, Nginx and the deploy controller probe.
 *
 * The addresses: `/v1/telegram`, the internal `/v1/telegram-drain`, `/v1/google-oauth/callback`
 * and the health check.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export const HEALTH_ROUTE = "/v1/health";

export interface RouteContext {
  /** Work that continues after the response; a stopping server waits for it. */
  waitUntil(work: Promise<unknown>): void;
}

export interface RuntimeRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  handle(request: Request, context: RouteContext): Promise<Response>;
}

export interface RuntimeServer {
  readonly port: number;
  close(graceMilliseconds: number): Promise<void>;
}

function toRequest(incoming: IncomingMessage, url: string, port: number): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(new URL(url, `http://127.0.0.1:${port}`), {
    ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" } : {}),
    headers,
    method,
  });
}

async function writeResponse(outgoing: ServerResponse, response: Response, head: boolean): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  const body = head ? null : Buffer.from(await response.arrayBuffer());
  outgoing.end(body ?? undefined);
}

function healthResponse(): Response {
  return Response.json({ ok: true, status: "ready" });
}

export async function startRuntimeServer(input: {
  readonly host: string;
  readonly port: number;
  readonly routes: readonly RuntimeRoute[];
}): Promise<RuntimeServer> {
  const routes = new Map<string, RuntimeRoute>();
  for (const route of input.routes) {
    const key = `${route.method} ${route.path}`;
    if (routes.has(key) || route.path === HEALTH_ROUTE) throw new Error(`AGENT_HTTP_ROUTE_DUPLICATE: ${key}`);
    routes.set(key, route);
  }
  const background = new Set<Promise<unknown>>();
  const context: RouteContext = {
    waitUntil(work) {
      const tracked = work.catch((error: unknown) => {
        // Nobody awaits background work; its failure is logged here once.
        console.error(JSON.stringify({ code: "AGENT_BACKGROUND_WORK_FAILED", error: error instanceof Error ? error.message : String(error) }));
      });
      background.add(tracked);
      void tracked.finally(() => background.delete(tracked));
    },
  };

  let port = input.port;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const method = incoming.method ?? "GET";
      const url = incoming.url ?? "/";
      const path = new URL(url, "http://127.0.0.1").pathname;
      try {
        if (path === HEALTH_ROUTE && (method === "GET" || method === "HEAD")) {
          await writeResponse(outgoing, healthResponse(), method === "HEAD");
          return;
        }
        const route = routes.get(`${method} ${path}`);
        if (route === undefined) {
          await writeResponse(outgoing, new Response(null, { status: 404 }), false);
          return;
        }
        await writeResponse(outgoing, await route.handle(toRequest(incoming, url, port), context), false);
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_HTTP_ROUTE_FAILED", error: error instanceof Error ? error.message : String(error), method, path,
        }));
        if (!outgoing.headersSent) outgoing.statusCode = 500;
        outgoing.end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, input.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("AGENT_HTTP_ADDRESS_UNKNOWN: the server has no TCP address");
  port = address.port;

  return {
    port,
    async close(graceMilliseconds) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMilliseconds); });
      await Promise.race([Promise.all([closed, Promise.allSettled([...background])]), grace]);
      clearTimeout(timer);
      server.closeAllConnections();
    },
  };
}
