/**
 * Usage reporting from the gateway to the agent.
 *
 * Constructs covered:
 * - Each use is reported once with its own id, its grant, its time and the service's status.
 * - A failed delivery keeps the uses for the next flush under the same ids, so the agent can
 *   count a resent batch once; a batch never exceeds the contract's size.
 * - Past the buffer bound the oldest uses are dropped and the drop is logged, not hidden.
 * - A batch the agent refuses as malformed is dropped and logged instead of blocking every later one.
 * - A missing or malformed encryption key leaves the proxy running: there is no sender, and the
 *   reason is logged with its code instead of stopping the egress of every sandbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_KEY_USAGE_BATCH_MAX, type ApiKeyUsageEvent } from "../../agent/lib/api-keys/api-key-contract.js";
import { randomBytes } from "node:crypto";

import { ApiKeyUsageRejected, agentUsageSenderFor, createApiKeyUsageReporter } from "./api-key-usage-reporter.js";

const GRANT = "5f0c6c1e-8a51-4f53-9a43-58b8d5b7c0aa";

describe("API key usage reporter", () => {
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("reports each use once with its grant, time and status", async () => {
    const send = vi.fn<(events: ApiKeyUsageEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    const reporter = createApiKeyUsageReporter({ maxBuffered: 10, now: () => new Date("2026-11-01T10:00:00Z"), send });

    reporter.record({ grantId: GRANT, status: 200 });
    reporter.record({ grantId: GRANT, status: null });
    await reporter.flush();
    await reporter.flush();

    expect(send).toHaveBeenCalledTimes(1);
    const events = send.mock.calls[0]![0];
    expect(events).toEqual([
      { grantId: GRANT, id: expect.any(String), status: 200, usedAt: "2026-11-01T10:00:00.000Z" },
      { grantId: GRANT, id: expect.any(String), status: null, usedAt: "2026-11-01T10:00:00.000Z" },
    ]);
    expect(events[0]!.id).not.toBe(events[1]!.id);
  });

  it("keeps the uses after a failed delivery and resends them under the same ids", async () => {
    const send = vi.fn<(events: ApiKeyUsageEvent[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("agent restarting"))
      .mockResolvedValue(undefined);
    const reporter = createApiKeyUsageReporter({ maxBuffered: 10, now: () => new Date(), send });

    reporter.record({ grantId: GRANT, status: 200 });
    await reporter.flush();
    await reporter.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toEqual(send.mock.calls[0]![0]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_SANDBOX_API_KEY_USAGE_REPORT_FAILED"));
  });

  it("drops a batch the agent refuses as malformed and goes on with the next", async () => {
    const send = vi.fn<(events: ApiKeyUsageEvent[]) => Promise<void>>()
      .mockRejectedValueOnce(new ApiKeyUsageRejected("agent answered HTTP 400"))
      .mockResolvedValue(undefined);
    const reporter = createApiKeyUsageReporter({ maxBuffered: 10, now: () => new Date(), send });

    reporter.record({ grantId: GRANT, status: 200 });
    await reporter.flush();
    reporter.record({ grantId: GRANT, status: 201 });
    await reporter.flush();

    expect(send.mock.calls.map(([events]) => events.map((event) => event.status))).toEqual([[200], [201]]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_SANDBOX_API_KEY_USAGE_REJECTED"));
  });

  it("sends no more than one contract batch at a time", async () => {
    const send = vi.fn<(events: ApiKeyUsageEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    const reporter = createApiKeyUsageReporter({ maxBuffered: API_KEY_USAGE_BATCH_MAX * 3, now: () => new Date(), send });

    for (let index = 0; index < API_KEY_USAGE_BATCH_MAX + 1; index += 1) reporter.record({ grantId: GRANT, status: 200 });
    await reporter.flush();

    expect(send.mock.calls.map(([events]) => events.length)).toEqual([API_KEY_USAGE_BATCH_MAX, 1]);
  });

  it("drops the oldest uses past the bound and logs how many", async () => {
    const send = vi.fn<(events: ApiKeyUsageEvent[]) => Promise<void>>().mockResolvedValue(undefined);
    const reporter = createApiKeyUsageReporter({ maxBuffered: 2, now: () => new Date(), send });

    reporter.record({ grantId: GRANT, status: 200 });
    reporter.record({ grantId: GRANT, status: 201 });
    reporter.record({ grantId: GRANT, status: 202 });
    await reporter.flush();

    expect(send.mock.calls[0]![0].map((event) => event.status)).toEqual([201, 202]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_SANDBOX_API_KEY_USAGE_DROPPED"));
  });

  it.each([undefined, "", "not-a-key"])("has no sender for the encryption key %j and says why", (key) => {
    expect(agentUsageSenderFor({ agentBaseUrl: "http://agent:3000", encryptionKey: key })).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_SANDBOX_API_KEY_GATEWAY_UNCONFIGURED"));
  });

  it("has a sender for a valid encryption key", () => {
    expect(agentUsageSenderFor({ agentBaseUrl: "http://agent:3000", encryptionKey: randomBytes(32).toString("base64") }))
      .toBeTypeOf("function");
    expect(error).not.toHaveBeenCalled();
  });
});
