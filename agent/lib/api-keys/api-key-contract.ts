/**
 * Contract between the agent, the sandbox runner and the egress proxy for sandbox API keys.
 *
 * Exports:
 * - Name, header and placeholder rules, the gateway address and the projection file name.
 * - `isApiKeyAuthHeader`: whether a header may carry a key.
 * - `createApiKeyPlaceholder`: a fresh placeholder for one grant.
 * - `normalizeUpstreamBaseUrl`: the only destination a key may reach, or null when it is unsafe.
 * - `apiKeyEnvironmentNames`, `apiKeyGatewayBaseUrl`: what a sandbox sees for one key.
 * - `groupEgressProxyAlias`: the proxy's DNS name on one external group's network.
 * - `authorizationValue`, `placeholderFromHeader`: the key's header in both directions.
 * - `serializeApiKeyProjection`, `parseApiKeyProjection`: the file the proxy reads per request.
 * - `parseApiKeyUsageBatch`: the usage the proxy reports back to the agent.
 *
 * The proxy reads the projection on every gateway request, so a damaged file fails as a whole: an
 * entry is never dropped or guessed.
 */
import { randomBytes } from "node:crypto";

import { z } from "zod";

export const API_KEY_NAME_PATTERN = /^[a-z][a-z0-9_]{1,31}$/u;
export const API_KEY_AUTH_HEADER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
// Headers that frame the request itself; a key written into one would break or redirect it.
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "connection", "content-length", "content-type", "host", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);
export const API_KEY_AUTH_SCHEMES = ["bearer", "raw"] as const;
export const API_KEY_PLACEHOLDER_PATTERN = /^osk_[A-Za-z0-9_-]{43}$/u;
export const API_KEY_GATEWAY_HOST = "sandbox-egress-proxy";
export const API_KEY_GATEWAY_PORT = 3129;
export const API_KEY_PROJECTION_FILE_NAME = "api-keys.json";
export const API_KEY_USAGE_ROUTE = "/v1/sandbox-api-key-usage";
export const API_KEY_USAGE_BATCH_MAX = 500;
export const API_KEY_UPSTREAM_URL_MAX_LENGTH = 300;

export type ApiKeyAuthScheme = (typeof API_KEY_AUTH_SCHEMES)[number];

const PLACEHOLDER_PREFIX = "osk_";
const PLACEHOLDER_BYTES = 32;
const PROJECTION_VERSION = 1;
const PROJECTION_ERROR = "AGENT_API_KEY_PROJECTION_INVALID";
// At least two labels and a top-level label with a letter: no address, no `localhost.`.
const PUBLIC_HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{0,62}[a-z][a-z0-9-]{0,62}$/u;
const BEARER_VALUE = /^Bearer[ \t]+(\S+)$/iu;

export function createApiKeyPlaceholder(): string {
  return `${PLACEHOLDER_PREFIX}${randomBytes(PLACEHOLDER_BYTES).toString("base64url")}`;
}

/**
 * A key goes only to an HTTPS host name on the standard port, never to an address, a port, a
 * query or credentials of the model's choosing. The result has no trailing slash.
 */
export function normalizeUpstreamBaseUrl(raw: string): string | null {
  if (!URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (
    url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
    raw.includes("?") || raw.includes("#") || !PUBLIC_HOST_NAME.test(url.hostname)
  ) {
    return null;
  }
  const normalized = `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  return normalized.length <= API_KEY_UPSTREAM_URL_MAX_LENGTH ? normalized : null;
}

/** A header that may carry a key: a plain lowercase name that does not frame the request. */
export function isApiKeyAuthHeader(name: string): boolean {
  return API_KEY_AUTH_HEADER_PATTERN.test(name) && !RESERVED_HEADERS.has(name);
}

export function apiKeyEnvironmentNames(name: string): { apiKey: string; baseUrl: string } {
  const prefix = name.toUpperCase();
  return { apiKey: `${prefix}_API_KEY`, baseUrl: `${prefix}_BASE_URL` };
}

export function apiKeyGatewayBaseUrl(name: string): string {
  return `http://${API_KEY_GATEWAY_HOST}:${API_KEY_GATEWAY_PORT}/${name}`;
}

export function groupEgressProxyAlias(workspaceId: string): string {
  return `sandbox-group-egress-proxy-${workspaceId}`;
}

export function authorizationValue(scheme: ApiKeyAuthScheme, secret: string): string {
  return scheme === "bearer" ? `Bearer ${secret}` : secret;
}

/** The placeholder a client put where the key belongs, or null when the header holds none. */
export function placeholderFromHeader(scheme: ApiKeyAuthScheme, value: string | undefined): string | null {
  if (value === undefined) return null;
  const candidate = scheme === "bearer" ? BEARER_VALUE.exec(value.trim())?.[1] : value.trim();
  return candidate !== undefined && API_KEY_PLACEHOLDER_PATTERN.test(candidate) ? candidate : null;
}

const encryptedValueSchema = z.strictObject({
  authTag: z.base64().min(1),
  ciphertext: z.base64().min(1),
  nonce: z.base64().min(1),
});

const grantSchema = z.strictObject({
  authHeader: z.string().refine(isApiKeyAuthHeader),
  authScheme: z.enum(API_KEY_AUTH_SCHEMES),
  grantId: z.uuid(),
  keyName: z.string().regex(API_KEY_NAME_PATTERN),
  network: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("trusted") }),
    z.strictObject({ kind: z.literal("group"), workspaceId: z.uuid() }),
  ]),
  placeholder: z.string().regex(API_KEY_PLACEHOLDER_PATTERN),
  upstreamBaseUrl: z.string().refine((value) => normalizeUpstreamBaseUrl(value) === value),
  value: encryptedValueSchema,
});

const projectionSchema = z.strictObject({
  grants: z.array(grantSchema),
  version: z.literal(PROJECTION_VERSION),
}).superRefine((projection, context) => {
  const placeholders = new Set(projection.grants.map((grant) => grant.placeholder));
  if (placeholders.size !== projection.grants.length) {
    context.addIssue({ code: "custom", message: "Duplicate placeholder", path: ["grants"] });
  }
});

export type ApiKeyProjectionGrant = z.infer<typeof grantSchema>;
export type ApiKeyEncryptedValue = z.infer<typeof encryptedValueSchema>;

export function serializeApiKeyProjection(grants: readonly ApiKeyProjectionGrant[]): string {
  return `${JSON.stringify({ grants, version: PROJECTION_VERSION })}\n`;
}

export function parseApiKeyProjection(text: string): ApiKeyProjectionGrant[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${PROJECTION_ERROR}: Projection is not valid JSON`, { cause: error });
  }
  const parsed = projectionSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${PROJECTION_ERROR}: ${z.prettifyError(parsed.error)}`);
  return parsed.data.grants;
}

const usageEventSchema = z.strictObject({
  grantId: z.uuid(),
  id: z.uuid(),
  status: z.number().int().min(100).max(599).nullable(),
  usedAt: z.iso.datetime({ offset: true }),
});

const usageBatchSchema = z.strictObject({
  events: z.array(usageEventSchema).min(1).max(API_KEY_USAGE_BATCH_MAX),
});

export type ApiKeyUsageEvent = z.infer<typeof usageEventSchema>;

export function parseApiKeyUsageBatch(value: unknown): ApiKeyUsageEvent[] {
  const parsed = usageBatchSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`AGENT_API_KEY_USAGE_BATCH_INVALID: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.events;
}
