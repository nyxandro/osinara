/**
 * The gateway through which sandbox scripts call a service with an owner's API key.
 *
 * Exports:
 * - `ApiKeyGatewayOptions`: the grants, the network check, decryption, resolution and usage sink.
 * - `createApiKeyGateway`: the internal HTTP server a sandbox calls at `<NAME>_BASE_URL`.
 *
 * A sandbox sends `http://sandbox-egress-proxy:3129/<name>/<path>` with the grant's placeholder in
 * the key's header. The gateway finds the grant by that placeholder, checks that the request came
 * from the grant's own network, puts the real key into the same header and sends the request over
 * HTTPS to the key's own service only.
 *
 * Security invariants:
 * - The destination is the key's stored base URL; the sandbox chooses only the path below it.
 * - The key is written only into its configured header, never into a body or a query.
 * - The service's host name resolves to a public address that is pinned for the connection.
 * - A refusal names no grant, key value or placeholder; logs carry the key name and grant id only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

import {
  API_KEY_NAME_PATTERN,
  authorizationValue,
  placeholderFromHeader,
  type ApiKeyEncryptedValue,
  type ApiKeyProjectionGrant,
} from "../../agent/lib/api-keys/api-key-contract.js";
import { writeEgressLog } from "./egress-log.js";
import { filteredHeaders } from "./http-headers.js";
import { withoutIpv4MappedPrefix } from "./network-access-gate.js";

const HTTPS_PORT = 443;
// A service may think for minutes before its first byte, as image generation does; the socket
// closes only after this long without any traffic.
const UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
const GATEWAY_ORIGIN = "http://sandbox-egress-proxy.invalid";
// Node passes any three-digit status through; the usage record keeps only HTTP's own range.
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

export interface ApiKeyGatewayOptions {
  decrypt(value: ApiKeyEncryptedValue): string;
  loadGrants(): Promise<readonly ApiKeyProjectionGrant[]>;
  /** The proxy's own address on the network the grant belongs to. */
  networkAddress(network: ApiKeyProjectionGrant["network"]): Promise<string>;
  recordUsage(event: { readonly grantId: string; readonly status: number | null }): void;
  resolveUpstream(hostname: string): Promise<{ readonly address: string; readonly family: 4 }>;
  /** Test seam: production sends HTTPS to port 443. */
  readonly upstream?: { readonly port: number; readonly request: typeof httpsRequest };
}

class GatewayRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly clientMessage: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

function notGranted(detail: string): GatewayRefusal {
  return new GatewayRefusal(
    403,
    "AGENT_SANDBOX_API_KEY_NOT_GRANTED",
    "This sandbox has no such API key. Use the <NAME>_BASE_URL and <NAME>_API_KEY variables exactly as set",
    detail,
  );
}

function headerValue(incoming: IncomingMessage, name: string): string | undefined {
  const value = incoming.headers[name];
  return Array.isArray(value) ? undefined : value;
}

/** The request's key name and the path below it; dot segments are resolved before the name is read. */
function parseGatewayPath(incoming: IncomingMessage): { name: string; rest: string; search: string } {
  const raw = incoming.url ?? "";
  if (!raw.startsWith("/")) {
    throw new GatewayRefusal(
      400,
      "AGENT_SANDBOX_API_KEY_REQUEST_INVALID",
      "Call <NAME>_BASE_URL directly, not through HTTP_PROXY",
      "request target is not in origin form",
    );
  }
  const url = new URL(raw, GATEWAY_ORIGIN);
  const [, name = "", ...rest] = url.pathname.split("/");
  if (!API_KEY_NAME_PATTERN.test(name)) throw notGranted("unknown key name");
  return { name, rest: rest.length > 0 ? `/${rest.join("/")}` : "", search: url.search };
}

function findGrant(
  incoming: IncomingMessage,
  name: string,
  grants: readonly ApiKeyProjectionGrant[],
): ApiKeyProjectionGrant {
  for (const grant of grants) {
    if (grant.keyName !== name) continue;
    const placeholder = placeholderFromHeader(grant.authScheme, headerValue(incoming, grant.authHeader));
    if (placeholder === grant.placeholder) return grant;
  }
  throw notGranted("no grant matches the placeholder");
}

function respond(outgoing: ServerResponse, status: number, body: string): void {
  if (!outgoing.headersSent) outgoing.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  outgoing.end(`${body}\n`);
}

export function createApiKeyGateway(options: ApiKeyGatewayOptions) {
  const upstream = options.upstream ?? { port: HTTPS_PORT, request: httpsRequest };

  return createServer((incoming, outgoing) => {
    let keyName: string | null = null;
    void (async () => {
      const path = parseGatewayPath(incoming);
      keyName = path.name;
      let grants: readonly ApiKeyProjectionGrant[];
      try {
        grants = await options.loadGrants();
      } catch (error) {
        throw new GatewayRefusal(
          503,
          "AGENT_SANDBOX_API_KEY_GATEWAY_UNAVAILABLE",
          "API keys are temporarily unavailable. Try again later",
          error instanceof Error ? error.message : String(error),
        );
      }
      const grant = findGrant(incoming, path.name, grants);
      let expected: string;
      try {
        expected = await options.networkAddress(grant.network);
      } catch (error) {
        // The proxy is not on that network, so the request cannot have come from it.
        throw notGranted(`network of grant ${grant.grantId} is not attached: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (withoutIpv4MappedPrefix(incoming.socket.localAddress) !== expected) {
        throw notGranted(`grant ${grant.grantId} belongs to another network`);
      }

      const base = new URL(grant.upstreamBaseUrl);
      const target = new URL(`${grant.upstreamBaseUrl}${path.rest}${path.search}`);
      let secret: string;
      try {
        secret = options.decrypt(grant.value);
      } catch (error) {
        throw new GatewayRefusal(
          503,
          "AGENT_SANDBOX_API_KEY_GATEWAY_UNAVAILABLE",
          "API keys are temporarily unavailable. Try again later",
          `grant ${grant.grantId} value cannot be decrypted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let resolved: { address: string };
      try {
        resolved = await options.resolveUpstream(base.hostname);
      } catch (error) {
        throw new GatewayRefusal(
          502,
          "AGENT_SANDBOX_API_KEY_UPSTREAM_FAILED",
          "The service of this API key could not be reached",
          error instanceof Error ? error.message : String(error),
        );
      }

      const headers = filteredHeaders(incoming.headers);
      delete headers.host;
      headers[grant.authHeader] = authorizationValue(grant.authScheme, secret);
      headers.host = base.host;
      const forwarded = upstream.request({
        headers,
        host: resolved.address,
        method: incoming.method,
        path: `${target.pathname}${target.search}`,
        port: upstream.port,
        servername: base.hostname,
        timeout: UPSTREAM_IDLE_TIMEOUT_MS,
      }, (response) => {
        const code = response.statusCode;
        const status = code !== undefined && code >= MIN_HTTP_STATUS && code <= MAX_HTTP_STATUS ? code : null;
        options.recordUsage({ grantId: grant.grantId, status });
        console.info(JSON.stringify({
          code: "AGENT_SANDBOX_API_KEY_USED",
          grantId: grant.grantId,
          host: base.host,
          keyName: grant.keyName,
          status: code ?? null,
        }));
        outgoing.writeHead(response.statusCode ?? 502, filteredHeaders(response.headers));
        response.pipe(outgoing);
      });
      forwarded.on("timeout", () => forwarded.destroy(
        new Error("AGENT_SANDBOX_API_KEY_UPSTREAM_TIMEOUT: Service sent nothing for too long"),
      ));
      forwarded.on("error", (error: NodeJS.ErrnoException) => {
        if (!outgoing.headersSent) options.recordUsage({ grantId: grant.grantId, status: null });
        writeEgressLog({
          code: "AGENT_SANDBOX_API_KEY_UPSTREAM_FAILED",
          errorCode: error.code ?? null,
          errorMessage: error.message,
          grantId: grant.grantId,
          host: base.host,
          keyName: grant.keyName,
        });
        if (outgoing.headersSent) {
          outgoing.destroy();
          return;
        }
        respond(outgoing, 502, "AGENT_SANDBOX_API_KEY_UPSTREAM_FAILED: The service of this API key could not be reached");
      });
      // A client that gives up must not leave the service's request running.
      outgoing.once("close", () => {
        if (!outgoing.writableFinished) forwarded.destroy();
      });
      incoming.pipe(forwarded);
    })().catch((error: unknown) => {
      const refusal = error instanceof GatewayRefusal ? error : null;
      writeEgressLog({
        code: refusal?.code ?? "AGENT_SANDBOX_API_KEY_GATEWAY_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        keyName,
      });
      respond(
        outgoing,
        refusal?.status ?? 500,
        refusal ? `${refusal.code}: ${refusal.clientMessage}` : "AGENT_SANDBOX_API_KEY_GATEWAY_FAILED: The request could not be processed",
      );
    });
  });
}
