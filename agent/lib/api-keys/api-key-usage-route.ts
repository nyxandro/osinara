/**
 * The agent's internal route that receives API key usage from the sandbox egress proxy.
 *
 * Exports:
 * - `createApiKeyUsageRoute`: the route over a usage sink and the integration key.
 * - `apiKeyUsageRoute`: the production route over the database.
 *
 * Nginx does not publish it; inside the server only the proxy holds the token, derived from the
 * integration key both of them read. A batch is recorded by its use ids, so a resent one counts once.
 */
import { timingSafeEqual } from "node:crypto";

import type { RuntimeRoute } from "../../runtime/server.js";
import { API_KEY_USAGE_ROUTE, parseApiKeyUsageBatch, type ApiKeyUsageEvent } from "./api-key-contract.js";
import { apiKeyUsageToken, INTEGRATION_KEY_ENVIRONMENT_NAME } from "./api-key-crypto.js";
import { apiKeyRepository } from "./api-key-repository.js";

const BEARER_PREFIX = "Bearer ";

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, { headers: { "content-type": "text/plain; charset=utf-8" }, status });
}

function sameToken(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function createApiKeyUsageRoute(dependencies: {
  integrationKey: () => string | undefined;
  record: (events: readonly ApiKeyUsageEvent[]) => Promise<number>;
}): RuntimeRoute {
  return {
    method: "POST",
    path: API_KEY_USAGE_ROUTE,
    async handle(request) {
      let expected: string;
      try {
        expected = apiKeyUsageToken(dependencies.integrationKey());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ code: "AGENT_API_KEY_USAGE_UNCONFIGURED", error: message }));
        return text(503, message);
      }
      const authorization = request.headers.get("authorization") ?? "";
      if (!authorization.startsWith(BEARER_PREFIX) || !sameToken(authorization.slice(BEARER_PREFIX.length), expected)) {
        return text(401, "AGENT_API_KEY_USAGE_UNAUTHORIZED: Unknown caller");
      }
      let events: ApiKeyUsageEvent[];
      try {
        events = parseApiKeyUsageBatch(await request.json());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return text(400, message.startsWith("AGENT_") ? message : `AGENT_API_KEY_USAGE_BATCH_INVALID: ${message}`);
      }
      return Response.json({ recorded: await dependencies.record(events) });
    },
  };
}

export const apiKeyUsageRoute = createApiKeyUsageRoute({
  integrationKey: () => process.env[INTEGRATION_KEY_ENVIRONMENT_NAME],
  record: (events) => apiKeyRepository.recordUsage(events),
});
