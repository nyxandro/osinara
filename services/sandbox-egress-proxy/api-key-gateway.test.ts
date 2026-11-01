/**
 * Sandbox API key gateway tests.
 *
 * Constructs covered:
 * - A request with the grant's placeholder goes to the key's own service with the real key in the
 *   key's header; the placeholder, the gateway host and proxy credentials never reach the service.
 * - The service's base path prefixes the request path; the query is kept.
 * - A placeholder of another key, an unknown one, a missing header or a grant of another network
 *   is refused before the service is contacted, and is not counted.
 * - Dot segments cannot move a request to another key's name.
 * - A request in forward-proxy form, an unreadable projection or a failed service is refused with
 *   its code; a failed service still counts as a use.
 */
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiKeyProjectionGrant } from "../../agent/lib/api-keys/api-key-contract.js";
import { createApiKeyGateway, type ApiKeyGatewayOptions } from "./api-key-gateway.js";

const NEURALDEEP_PLACEHOLDER = `osk_${"n".repeat(43)}`;
const ANTHROPIC_PLACEHOLDER = `osk_${"a".repeat(43)}`;
const FOREIGN_PLACEHOLDER = `osk_${"f".repeat(43)}`;
const GROUP_WORKSPACE = "0b8f0f5e-6a1d-4f0e-9a0e-3c9d6f1a2b3c";
const OTHER_GROUP_WORKSPACE = "1b8f0f5e-6a1d-4f0e-9a0e-3c9d6f1a2b3c";
const VALUE = { authTag: "dGFn", ciphertext: "c2VjcmV0", nonce: "bm9uY2U=" };

const GRANTS: ApiKeyProjectionGrant[] = [
  {
    authHeader: "authorization", authScheme: "bearer", grantId: "5f0c6c1e-8a51-4f53-9a43-58b8d5b7c0aa",
    keyName: "neuraldeep", network: { kind: "group", workspaceId: GROUP_WORKSPACE },
    placeholder: NEURALDEEP_PLACEHOLDER, upstreamBaseUrl: "https://api.neuraldeep.ru", value: VALUE,
  },
  {
    authHeader: "x-api-key", authScheme: "raw", grantId: "6f0c6c1e-8a51-4f53-9a43-58b8d5b7c0aa",
    keyName: "anthropic", network: { kind: "trusted" },
    placeholder: ANTHROPIC_PLACEHOLDER, upstreamBaseUrl: "https://api.anthropic.com/v1", value: VALUE,
  },
  {
    authHeader: "authorization", authScheme: "bearer", grantId: "7f0c6c1e-8a51-4f53-9a43-58b8d5b7c0aa",
    keyName: "neuraldeep", network: { kind: "group", workspaceId: OTHER_GROUP_WORKSPACE },
    placeholder: FOREIGN_PLACEHOLDER, upstreamBaseUrl: "https://api.neuraldeep.ru", value: VALUE,
  },
];

interface Received {
  headers: IncomingHttpHeaders;
  method: string;
  url: string;
}

let upstream: Server;
let gateway: Server;
let upstreamPort: number;
let gatewayPort: number;
let received: Received[];
let upstreamStatus: number;
let options: ApiKeyGatewayOptions;
let recordUsage: ReturnType<typeof vi.fn>;
let resolveUpstream: ReturnType<typeof vi.fn>;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function call(path: string, headers: Record<string, string> = {}, method = "POST", body = '{"prompt":"кот"}') {
  return new Promise<{ body: string; status: number }>((resolve, reject) => {
    const outgoing = request({ headers, host: "127.0.0.1", method, path, port: gatewayPort }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ body: text, status: response.statusCode ?? 0 }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function bearer(placeholder: string) {
  return { authorization: `Bearer ${placeholder}` };
}

describe("sandbox API key gateway", () => {
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    received = [];
    upstreamStatus = 200;
    upstream = createServer((incoming, outgoing) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => { body += chunk; });
      incoming.on("end", () => {
        received.push({ headers: incoming.headers, method: incoming.method ?? "", url: incoming.url ?? "" });
        outgoing.writeHead(upstreamStatus, { "content-type": "application/json", "x-request-id": "r1" });
        outgoing.end(`{"echo":${JSON.stringify(body)}}`);
      });
    });
    upstreamPort = await listen(upstream);
    recordUsage = vi.fn();
    resolveUpstream = vi.fn().mockResolvedValue({ address: "127.0.0.1", family: 4 });
    options = {
      decrypt: () => "sk-real-key",
      loadGrants: async () => GRANTS,
      networkAddress: async (network) =>
        network.kind === "trusted" || network.workspaceId === GROUP_WORKSPACE ? "127.0.0.1" : "10.9.9.9",
      recordUsage,
      resolveUpstream,
      upstream: { port: upstreamPort, request },
    };
    gateway = createApiKeyGateway(options);
    gatewayPort = await listen(gateway);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await close(gateway);
    await close(upstream);
  });

  it("sends the real key only to the key's own service in the key's header", async () => {
    const result = await call("/neuraldeep/v1/images/generations?size=1024", {
      ...bearer(NEURALDEEP_PLACEHOLDER),
      "content-type": "application/json",
      "proxy-authorization": "Basic c2VjcmV0",
    });

    expect(result).toEqual({ body: '{"echo":"{\\"prompt\\":\\"кот\\"}"}', status: 200 });
    expect(resolveUpstream).toHaveBeenCalledWith("api.neuraldeep.ru");
    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe("POST");
    expect(received[0]!.url).toBe("/v1/images/generations?size=1024");
    expect(received[0]!.headers.authorization).toBe("Bearer sk-real-key");
    expect(received[0]!.headers.host).toBe("api.neuraldeep.ru");
    expect(received[0]!.headers["proxy-authorization"]).toBeUndefined();
    expect(JSON.stringify(received[0]!.headers)).not.toContain(NEURALDEEP_PLACEHOLDER);
    expect(recordUsage).toHaveBeenCalledWith({ grantId: GRANTS[0]!.grantId, status: 200 });
  });

  it("prefixes the service's base path and writes a raw key into its own header", async () => {
    const result = await call("/anthropic/messages", { "x-api-key": ANTHROPIC_PLACEHOLDER });

    expect(result.status).toBe(200);
    expect(received[0]!.url).toBe("/v1/messages");
    expect(received[0]!.headers["x-api-key"]).toBe("sk-real-key");
    expect(received[0]!.headers.host).toBe("api.anthropic.com");
  });

  it.each([
    ["another key's placeholder", "/anthropic/messages", { "x-api-key": NEURALDEEP_PLACEHOLDER }],
    ["a placeholder in the wrong scheme", "/neuraldeep/v1/models", { authorization: NEURALDEEP_PLACEHOLDER }],
    ["an unknown placeholder", "/neuraldeep/v1/models", bearer(`osk_${"u".repeat(43)}`)],
    ["no key header", "/neuraldeep/v1/models", {}],
    ["a grant of another network", "/neuraldeep/v1/models", bearer(FOREIGN_PLACEHOLDER)],
    ["dot segments towards another key", "/neuraldeep/../anthropic/messages", bearer(NEURALDEEP_PLACEHOLDER)],
    ["an unknown key name", "/unknown/v1", bearer(NEURALDEEP_PLACEHOLDER)],
  ])("refuses %s before contacting any service", async (_case, path, headers) => {
    const result = await call(path, headers);

    expect(result.status).toBe(403);
    expect(result.body).toMatch(/^AGENT_SANDBOX_API_KEY_NOT_GRANTED: /u);
    expect(received).toHaveLength(0);
    expect(resolveUpstream).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("refuses a grant whose network the proxy is not attached to", async () => {
    await close(gateway);
    gateway = createApiKeyGateway({ ...options, networkAddress: async () => { throw new Error("ENOTFOUND"); } });
    gatewayPort = await listen(gateway);

    const result = await call("/neuraldeep/v1/models", bearer(NEURALDEEP_PLACEHOLDER));

    expect(result.status).toBe(403);
    expect(result.body).toMatch(/^AGENT_SANDBOX_API_KEY_NOT_GRANTED: /u);
    expect(received).toHaveLength(0);
  });

  it("refuses a request written for a forward proxy", async () => {
    const result = await call("http://api.neuraldeep.ru/v1/models", bearer(NEURALDEEP_PLACEHOLDER), "GET", "");

    expect(result.status).toBe(400);
    expect(result.body).toMatch(/^AGENT_SANDBOX_API_KEY_REQUEST_INVALID: /u);
    expect(received).toHaveLength(0);
  });

  it("refuses every request while the projection cannot be read", async () => {
    await close(gateway);
    gateway = createApiKeyGateway({ ...options, loadGrants: async () => { throw new Error("AGENT_API_KEY_PROJECTION_INVALID: broken"); } });
    gatewayPort = await listen(gateway);

    const result = await call("/neuraldeep/v1/models", bearer(NEURALDEEP_PLACEHOLDER));

    expect(result.status).toBe(503);
    expect(result.body).toMatch(/^AGENT_SANDBOX_API_KEY_GATEWAY_UNAVAILABLE: /u);
    expect(received).toHaveLength(0);
  });

  it("passes the service's own answer through, an error status included", async () => {
    upstreamStatus = 401;

    const result = await call("/neuraldeep/v1/models", bearer(NEURALDEEP_PLACEHOLDER), "GET", "");

    expect(result.status).toBe(401);
    expect(recordUsage).toHaveBeenCalledWith({ grantId: GRANTS[0]!.grantId, status: 401 });
  });

  it("counts a use with a status outside HTTP's range as one without a status", async () => {
    upstreamStatus = 999;

    const result = await call("/neuraldeep/v1/models", bearer(NEURALDEEP_PLACEHOLDER), "GET", "");

    expect(result.status).toBe(999);
    expect(recordUsage).toHaveBeenCalledWith({ grantId: GRANTS[0]!.grantId, status: null });
  });

  it("answers 502 when the service cannot be reached and still counts the use", async () => {
    await close(upstream);

    const result = await call("/neuraldeep/v1/models", bearer(NEURALDEEP_PLACEHOLDER), "GET", "");

    expect(result.status).toBe(502);
    expect(result.body).toMatch(/^AGENT_SANDBOX_API_KEY_UPSTREAM_FAILED: /u);
    expect(recordUsage).toHaveBeenCalledWith({ grantId: GRANTS[0]!.grantId, status: null });
    upstream = createServer();
    await listen(upstream);
  });

  it("answers 502 when the service's name has no public address, without counting a use", async () => {
    resolveUpstream.mockRejectedValue(new Error("AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN: no public IPv4"));

    const result = await call("/neuraldeep/v1/models", bearer(NEURALDEEP_PLACEHOLDER), "GET", "");

    expect(result.status).toBe(502);
    expect(result.body).toMatch(/^AGENT_SANDBOX_API_KEY_UPSTREAM_FAILED: /u);
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
