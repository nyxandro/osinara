/**
 * How the ingress worker reports a drain that did not reach the agent.
 *
 * Constructs covered:
 * - Before the agent first answers, inside the start-up grace, a failure is a routine wait.
 * - After the agent answered once, or once the grace is over, a failure is a failure.
 */
import { describe, expect, it } from "vitest";

import {
  DRAIN_STARTUP_GRACE_MILLISECONDS,
  drainFailureCode,
} from "./telegram-ingress-drain-failure.js";

describe("drainFailureCode", () => {
  const startedAt = 1_000_000;

  it("waits quietly while the agent is still coming up after the worker", () => {
    // 02.10, after a reboot: the worker started 36 s before the agent and wrote eleven failures,
    // which lit OsinaraErrorBurst while nobody was without an answer (#317).
    expect(drainFailureCode({ agentAnswered: false, now: startedAt + 36_000, startedAt }))
      .toBe("AGENT_TELEGRAM_DRAIN_WAITING");
  });

  it("reports a failure once the agent has answered", () => {
    expect(drainFailureCode({ agentAnswered: true, now: startedAt + 1_000, startedAt }))
      .toBe("AGENT_TELEGRAM_DRAIN_FAILED");
  });

  it("reports a failure when the agent never came up within the grace", () => {
    expect(drainFailureCode({ agentAnswered: false, now: startedAt + DRAIN_STARTUP_GRACE_MILLISECONDS, startedAt }))
      .toBe("AGENT_TELEGRAM_DRAIN_FAILED");
  });
});
