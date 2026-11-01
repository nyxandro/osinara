/**
 * The agent's internal route that receives API key usage from the egress proxy.
 *
 * Constructs covered:
 * - Only the proxy's token is accepted; any other caller is refused before the body is read.
 * - A valid batch is recorded as reported; a malformed one is refused with its code.
 * - Without the encryption key the route says it is not configured instead of guessing.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { API_KEY_USAGE_ROUTE } from "./api-key-contract.js";
import { apiKeyUsageToken } from "./api-key-crypto.js";
import { createApiKeyUsageRoute } from "./api-key-usage-route.js";

const KEY = randomBytes(32).toString("base64");
const EVENT = {
  grantId: "5f0c6c1e-8a51-4f53-9a43-58b8d5b7c0aa",
  id: "7f0c6c1e-8a51-4f53-9a43-58b8d5b7c0aa",
  status: 200,
  usedAt: "2026-11-01T10:00:00.000Z",
};
const CONTEXT = { waitUntil: () => undefined };

function post(body: unknown, token?: string): Request {
  return new Request(`http://agent:3000${API_KEY_USAGE_ROUTE}`, {
    body: JSON.stringify(body),
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    method: "POST",
  });
}

describe("API key usage route", () => {
  it("records a batch the proxy reports", async () => {
    const record = vi.fn().mockResolvedValue(1);
    const route = createApiKeyUsageRoute({ encryptionKey: () => KEY, record });

    const response = await route.handle(post({ events: [EVENT] }, apiKeyUsageToken(KEY)), CONTEXT);

    expect(route).toMatchObject({ method: "POST", path: API_KEY_USAGE_ROUTE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: 1 });
    expect(record).toHaveBeenCalledWith([EVENT]);
  });

  it.each([undefined, "wrong-token", apiKeyUsageToken(randomBytes(32).toString("base64"))])(
    "refuses a caller with token %j",
    async (token) => {
      const record = vi.fn();
      const route = createApiKeyUsageRoute({ encryptionKey: () => KEY, record });

      const response = await route.handle(post({ events: [EVENT] }, token), CONTEXT);

      expect(response.status).toBe(401);
      expect(record).not.toHaveBeenCalled();
    },
  );

  it("refuses a malformed batch with its code", async () => {
    const record = vi.fn();
    const route = createApiKeyUsageRoute({ encryptionKey: () => KEY, record });

    const response = await route.handle(post({ events: [{ ...EVENT, id: "not-a-uuid" }] }, apiKeyUsageToken(KEY)), CONTEXT);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("AGENT_API_KEY_USAGE_BATCH_INVALID");
    expect(record).not.toHaveBeenCalled();
  });

  it("says it is not configured when the encryption key is absent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const record = vi.fn();
    const route = createApiKeyUsageRoute({ encryptionKey: () => undefined, record });

    const response = await route.handle(post({ events: [EVENT] }, "anything"), CONTEXT);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("AGENT_API_KEY_ENCRYPTION_KEY_MISSING");
    expect(record).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
