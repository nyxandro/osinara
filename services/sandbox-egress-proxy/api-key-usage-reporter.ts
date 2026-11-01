/**
 * Usage of sandbox API keys, reported from the gateway to the agent.
 *
 * Exports:
 * - `ApiKeyUsageRejected`: the agent refused a batch as malformed; sending it again cannot help.
 * - `createApiKeyUsageReporter`: buffers uses in memory and delivers them in batches.
 * - `createAgentUsageSender`: delivers one batch to the agent's internal usage route.
 *
 * The proxy has no database. Each use gets its id when it happens, and a batch whose delivery
 * failed is sent again under the same ids, so the agent counts it once. A restart of the proxy
 * loses the uses not yet delivered; that is the accepted price of an in-memory buffer.
 */
import { randomUUID } from "node:crypto";

import {
  API_KEY_USAGE_BATCH_MAX,
  API_KEY_USAGE_ROUTE,
  type ApiKeyUsageEvent,
} from "../../agent/lib/api-keys/api-key-contract.js";

const SEND_TIMEOUT_MS = 10_000;
const HTTP_BAD_REQUEST = 400;

export class ApiKeyUsageRejected extends Error {
  constructor(message: string) {
    super(`AGENT_SANDBOX_API_KEY_USAGE_REJECTED: ${message}`);
    this.name = "ApiKeyUsageRejected";
  }
}

export interface ApiKeyUsageReporter {
  flush(): Promise<void>;
  record(event: { readonly grantId: string; readonly status: number | null }): void;
  /** Flushes on a fixed interval; returns the function that stops it. */
  start(intervalMilliseconds: number): () => void;
}

export function createApiKeyUsageReporter(options: {
  readonly maxBuffered: number;
  readonly now: () => Date;
  readonly send: (events: ApiKeyUsageEvent[]) => Promise<void>;
}): ApiKeyUsageReporter {
  let buffer: ApiKeyUsageEvent[] = [];
  let dropped = 0;
  let running: Promise<void> | null = null;

  const deliver = async (): Promise<void> => {
    if (dropped > 0) {
      console.error(JSON.stringify({ code: "AGENT_SANDBOX_API_KEY_USAGE_DROPPED", count: dropped }));
      dropped = 0;
    }
    while (buffer.length > 0) {
      const batch = buffer.slice(0, API_KEY_USAGE_BATCH_MAX);
      try {
        await options.send(batch);
      } catch (error) {
        if (error instanceof ApiKeyUsageRejected) {
          // Resending the same batch would block every later one behind it.
          console.error(JSON.stringify({ code: "AGENT_SANDBOX_API_KEY_USAGE_REJECTED", count: batch.length, errorMessage: error.message }));
          const rejected = new Set(batch.map((event) => event.id));
          buffer = buffer.filter((event) => !rejected.has(event.id));
          continue;
        }
        console.error(JSON.stringify({
          code: "AGENT_SANDBOX_API_KEY_USAGE_REPORT_FAILED",
          errorMessage: error instanceof Error ? error.message : String(error),
          pending: buffer.length,
        }));
        return;
      }
      // Uses recorded or dropped during the delivery stay as they are.
      const sent = new Set(batch.map((event) => event.id));
      buffer = buffer.filter((event) => !sent.has(event.id));
    }
  };

  const flush = (): Promise<void> => {
    running ??= deliver().finally(() => { running = null; });
    return running;
  };

  return {
    flush,
    record({ grantId, status }) {
      buffer.push({ grantId, id: randomUUID(), status, usedAt: options.now().toISOString() });
      if (buffer.length > options.maxBuffered) {
        dropped += buffer.length - options.maxBuffered;
        buffer = buffer.slice(-options.maxBuffered);
      }
    },
    start(intervalMilliseconds) {
      const timer = setInterval(() => { void flush(); }, intervalMilliseconds);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

export function createAgentUsageSender(input: {
  readonly agentBaseUrl: string;
  readonly token: string;
}): (events: ApiKeyUsageEvent[]) => Promise<void> {
  const url = new URL(API_KEY_USAGE_ROUTE, input.agentBaseUrl);
  return async (events) => {
    const response = await fetch(url, {
      body: JSON.stringify({ events }),
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.status === HTTP_BAD_REQUEST) {
      throw new ApiKeyUsageRejected(`agent answered HTTP ${response.status}: ${await response.text()}`);
    }
    if (!response.ok) {
      throw new Error(`AGENT_SANDBOX_API_KEY_USAGE_HTTP_FAILED: agent answered HTTP ${response.status}`);
    }
  };
}
