/**
 * How the ingress worker reports a drain that did not reach the agent.
 *
 * Exports:
 * - `DRAIN_STARTUP_GRACE_MILLISECONDS`: how long after its own start the worker waits quietly.
 * - `drainFailureCode`: whether one failed drain is a routine wait or a failure.
 *
 * After a reboot Docker starts containers by their restart policy, not by `depends_on`: the
 * worker came up 36 seconds before the agent, wrote eleven failures, and OsinaraErrorBurst fired
 * while nobody was waiting for an answer (#317). Until the agent first answers, and only for a
 * bounded time, a failed drain is the agent still starting. After that every one is reported, so
 * an agent that never comes up is still an alert, only a few minutes later.
 */

// The agent was up 36 s after the worker on 02.10, recovering a crashed database included.
export const DRAIN_STARTUP_GRACE_MILLISECONDS = 3 * 60_000;

export function drainFailureCode(input: {
  agentAnswered: boolean;
  now: number;
  startedAt: number;
}): "AGENT_TELEGRAM_DRAIN_FAILED" | "AGENT_TELEGRAM_DRAIN_WAITING" {
  if (input.agentAnswered) return "AGENT_TELEGRAM_DRAIN_FAILED";
  return input.now - input.startedAt < DRAIN_STARTUP_GRACE_MILLISECONDS
    ? "AGENT_TELEGRAM_DRAIN_WAITING"
    : "AGENT_TELEGRAM_DRAIN_FAILED";
}
