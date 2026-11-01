/**
 * Sandbox API key contract tests.
 *
 * Constructs covered:
 * - A key reaches only an HTTPS host name on the standard port; an address, a port, a query,
 *   credentials or a plain-HTTP URL is refused, and the accepted form has no trailing slash.
 * - A placeholder is read only from where the key belongs, in the key's own scheme.
 * - The projection fails as a whole on one damaged entry or a repeated placeholder.
 * - Properties: normalizing never throws, its result is safe and normalizing it again changes
 *   nothing; the projection survives serialize then parse unchanged.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  apiKeyEnvironmentNames,
  apiKeyGatewayBaseUrl,
  authorizationValue,
  createApiKeyPlaceholder,
  normalizeUpstreamBaseUrl,
  parseApiKeyProjection,
  parseApiKeyUsageBatch,
  placeholderFromHeader,
  serializeApiKeyProjection,
  type ApiKeyProjectionGrant,
} from "./api-key-contract.js";

const PLACEHOLDER = `osk_${"a".repeat(43)}`;

function grant(overrides: Partial<ApiKeyProjectionGrant> = {}): ApiKeyProjectionGrant {
  return {
    authHeader: "authorization",
    authScheme: "bearer",
    grantId: "5f0c6c1e-8a51-4f53-9a43-58b8d5b7c0aa",
    keyName: "neuraldeep",
    network: { kind: "group", workspaceId: "0b8f0f5e-6a1d-4f0e-9a0e-3c9d6f1a2b3c" },
    placeholder: PLACEHOLDER,
    upstreamBaseUrl: "https://api.neuraldeep.ru",
    value: { authTag: "dGFn", ciphertext: "c2VjcmV0", nonce: "bm9uY2U=" },
    ...overrides,
  };
}

describe("upstream base URL", () => {
  it("keeps an HTTPS host and its path without a trailing slash", () => {
    expect(normalizeUpstreamBaseUrl("https://api.neuraldeep.ru/")).toBe("https://api.neuraldeep.ru");
    expect(normalizeUpstreamBaseUrl("https://API.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(normalizeUpstreamBaseUrl("https://api.example.com:443/v1")).toBe("https://api.example.com/v1");
  });

  it.each([
    "http://api.example.com",
    "https://api.example.com:8443",
    "https://1.2.3.4/v1",
    "https://[::1]/v1",
    "https://localhost/v1",
    "https://user:pass@api.example.com",
    "https://api.example.com/v1?key=1",
    "https://api.example.com/v1?",
    "https://api.example.com/#frag",
    "api.example.com",
    `https://api.example.com/${"a".repeat(300)}`,
  ])("refuses %s", (raw) => {
    expect(normalizeUpstreamBaseUrl(raw)).toBeNull();
  });

  it("never throws, and what it accepts is safe and already normalized", () => {
    const urlLike = fc.oneof(
      fc.webUrl({ withFragments: true, withQueryParameters: true }),
      fc.tuple(fc.constantFrom("https://", "http://", "HTTPS://", ""), fc.string({ maxLength: 60 }))
        .map(([scheme, rest]) => `${scheme}${rest}`),
      fc.string({ maxLength: 80, unit: "binary" }),
    );
    fc.assert(fc.property(urlLike, (raw) => {
      const normalized = normalizeUpstreamBaseUrl(raw);
      if (normalized === null) return;
      const url = new URL(normalized);
      expect(url.protocol).toBe("https:");
      expect(url.port).toBe("");
      expect(`${url.username}${url.password}${url.search}${url.hash}`).toBe("");
      expect(url.hostname).toMatch(/\.[^.]/u);
      expect(url.hostname).not.toMatch(/^[0-9.]+$/u);
      expect(normalized.endsWith("/")).toBe(false);
      expect(normalizeUpstreamBaseUrl(normalized)).toBe(normalized);
    }), { examples: [["https://api.example.com//"], ["https://a.b/c/../d/"], ["https://a.b:443"]] });
  });
});

describe("what a sandbox sees", () => {
  it("names the variables after the key and points the base URL at the gateway", () => {
    expect(apiKeyEnvironmentNames("neuraldeep")).toEqual({
      apiKey: "NEURALDEEP_API_KEY",
      baseUrl: "NEURALDEEP_BASE_URL",
    });
    expect(apiKeyGatewayBaseUrl("neuraldeep")).toBe("http://sandbox-egress-proxy:3129/neuraldeep");
  });

  it("creates distinct placeholders in the declared format", () => {
    const first = createApiKeyPlaceholder();
    expect(first).toMatch(/^osk_[A-Za-z0-9_-]{43}$/u);
    expect(createApiKeyPlaceholder()).not.toBe(first);
  });
});

describe("the key's header", () => {
  it("reads a bearer placeholder and writes the key back in the same scheme", () => {
    expect(placeholderFromHeader("bearer", `Bearer ${PLACEHOLDER}`)).toBe(PLACEHOLDER);
    expect(placeholderFromHeader("bearer", `bearer  ${PLACEHOLDER}`)).toBe(PLACEHOLDER);
    expect(authorizationValue("bearer", "sk-real")).toBe("Bearer sk-real");
  });

  it("reads a raw placeholder and writes the bare key", () => {
    expect(placeholderFromHeader("raw", PLACEHOLDER)).toBe(PLACEHOLDER);
    expect(authorizationValue("raw", "sk-real")).toBe("sk-real");
  });

  it.each([
    ["bearer", PLACEHOLDER],
    ["bearer", `Token ${PLACEHOLDER}`],
    ["bearer", "Bearer sk-real-key"],
    ["raw", `Bearer ${PLACEHOLDER}`],
    ["raw", undefined],
  ] as const)("finds no placeholder for %s %s", (scheme, value) => {
    expect(placeholderFromHeader(scheme, value)).toBeNull();
  });
});

describe("projection file", () => {
  it("refuses the whole file over one damaged entry or a repeated placeholder", () => {
    expect(() => parseApiKeyProjection(serializeApiKeyProjection([grant({ upstreamBaseUrl: "http://x.ru" })])))
      .toThrow("AGENT_API_KEY_PROJECTION_INVALID");
    expect(() => parseApiKeyProjection(serializeApiKeyProjection([
      grant(),
      grant({ grantId: "6f0c6c1e-8a51-4f53-9a43-58b8d5b7c0aa" }),
    ]))).toThrow("AGENT_API_KEY_PROJECTION_INVALID");
    expect(() => parseApiKeyProjection("{")).toThrow("AGENT_API_KEY_PROJECTION_INVALID");
  });

  it("survives serialize then parse unchanged", () => {
    const base64 = fc.uint8Array({ minLength: 1, maxLength: 48 }).map((bytes) => Buffer.from(bytes).toString("base64"));
    const projectionGrant = fc.record({
      authHeader: fc.constantFrom("authorization", "x-api-key", "api-key"),
      authScheme: fc.constantFrom("bearer" as const, "raw" as const),
      grantId: fc.uuid({ version: 4 }),
      keyName: fc.stringMatching(/^[a-z][a-z0-9_]{1,31}$/u),
      network: fc.oneof(
        fc.constant({ kind: "trusted" as const }),
        fc.uuid({ version: 4 }).map((workspaceId) => ({ kind: "group" as const, workspaceId })),
      ),
      placeholder: fc.constant(null).map(() => createApiKeyPlaceholder()),
      upstreamBaseUrl: fc.constantFrom("https://api.neuraldeep.ru", "https://api.example.com/v1"),
      value: fc.record({ authTag: base64, ciphertext: base64, nonce: base64 }),
    });
    fc.assert(fc.property(fc.array(projectionGrant, { maxLength: 5 }), (grants) => {
      expect(parseApiKeyProjection(serializeApiKeyProjection(grants))).toEqual(grants);
    }));
  });
});

describe("usage batch", () => {
  it("accepts reported events and refuses an empty or malformed batch", () => {
    const event = {
      grantId: "5f0c6c1e-8a51-4f53-9a43-58b8d5b7c0aa",
      id: "7f0c6c1e-8a51-4f53-9a43-58b8d5b7c0aa",
      status: 200,
      usedAt: "2026-11-01T10:00:00.000Z",
    };
    expect(parseApiKeyUsageBatch({ events: [event, { ...event, status: null }] })).toHaveLength(2);
    expect(() => parseApiKeyUsageBatch({ events: [] })).toThrow("AGENT_API_KEY_USAGE_BATCH_INVALID");
    expect(() => parseApiKeyUsageBatch({ events: [{ ...event, status: 42 }] }))
      .toThrow("AGENT_API_KEY_USAGE_BATCH_INVALID");
  });
});
