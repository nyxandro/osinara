/**
 * External TLS proxy probe executed before the irreversible installation boundary.
 *
 * Exports:
 * - `probeExternalProxy`: proves that the operator's proxy publishes the hostname AND routes it to
 *   Osinara, not merely that something answers HTTPS for that name.
 *
 * Key constructs:
 * - A one-shot listener on the loopback edge port answers the health path with a random token.
 * - A host-level proxy forwarding to the edge port returns that token end to end.
 * - A containerized proxy whose upstream `edge` does not exist yet returns a gateway error.
 * - Any other answer means the name is served by something else: fail before migrations start.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { InstallerError } from "./errors.js";

const PROBE_TIMEOUT_MS = 10_000;
const HEALTH_PATH = "/eve/v1/health";
/** Gateway errors are the only acceptable non-token answers: the upstream is simply not up yet. */
const UPSTREAM_MISSING_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export interface ExternalProxyProbeInput {
  readonly fetch: typeof fetch;
  readonly hostname: string;
  /** Loopback port the edge will publish after installation; must be free when the probe runs. */
  readonly listenPort: number;
}

async function listenOnLoopback(port: number, token: string) {
  const server = createServer((request, response) => {
    if (request.url === HEALTH_PATH) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(token);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ exclusive: true, host: "127.0.0.1", port }, () => resolve());
  }).catch((error: unknown) => {
    throw new InstallerError(
      "OSINARA_INSTALL_PORT_UNAVAILABLE",
      `Порт ${port} занят. Освободите его перед установкой`,
      { cause: error },
    );
  });
  return server;
}

export async function probeExternalProxy(input: ExternalProxyProbeInput): Promise<void> {
  const token = randomUUID();
  const server = await listenOnLoopback(input.listenPort, token);
  try {
    let response: Response;
    try {
      response = await input.fetch(`https://${input.hostname}${HEALTH_PATH}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new InstallerError(
        "OSINARA_INSTALL_EXTERNAL_PROXY_UNREACHABLE",
        `Существующий прокси не отвечает по https://${input.hostname}. Настройте на нём пересылку этого имени `
          + `на 127.0.0.1:${input.listenPort} и повторите установку. Docker-сеть osinara-production-edge-frontend `
          + "появится только после установки",
        { cause: error },
      );
    }
    if (UPSTREAM_MISSING_STATUSES.has(response.status)) return;
    const body = await response.text();
    if (response.status === 200 && body === token) return;
    throw new InstallerError(
      "OSINARA_INSTALL_EXTERNAL_PROXY_MISROUTED",
      `Прокси отвечает по https://${input.hostname}, но не пересылает запросы в Osinara (получен статус `
        + `${response.status}). Направьте это имя на 127.0.0.1:${input.listenPort} и повторите установку`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
