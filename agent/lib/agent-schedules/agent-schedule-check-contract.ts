/**
 * The contract of a monitor's check: a short Bash script the scheduler runs without the model.
 *
 * Exports:
 * - Limits of a check: script length, run time, interval, monitoring window, model-facing output.
 * - `ScheduleCheckOutcome` and `classifyScheduleCheck`: what one run of the script means.
 * - `ScheduleCheckTrigger`: why a monitor woke the agent.
 * - `scheduleCheckProcess`: the sandbox command that runs a script under its own timeout.
 *
 * Key constructs:
 * - Empty output means nothing happened yet, printed text is the event, a non-zero exit is a broken
 *   check. A failure is never read as "nothing yet", so a broken script cannot pass for silence.
 * - The script travels in an environment variable: the model's text is never spliced into a shell
 *   line, and GNU `timeout` ends it gently instead of the runner removing the chat's container.
 * - Its output is cut at the source: a script flooding stdout ends on a broken pipe, which counts as
 *   a broken check, and never reaches the runner's own limit, which would remove the container
 *   together with whatever the chat's turn runs in it.
 */
export const SCHEDULE_CHECK_COMMAND_MAX_LENGTH = 4_000;
export const SCHEDULE_CHECK_TIMEOUT_SECONDS = 60;
// What the model sees of an event; a longer report belongs in a file the check writes.
export const SCHEDULE_CHECK_OUTPUT_MAX_LENGTH = 4_000;
export const SCHEDULE_CHECK_DETAIL_MAX_LENGTH = 1_500;
// A check keeps the chat's sandbox container awake, so it runs at most this often.
export const SCHEDULE_CHECK_MIN_INTERVAL_MINUTES = 5;
export const SCHEDULE_CHECK_MAX_WINDOW_DAYS = 14;
// Consecutive broken checks after which the agent is woken to repair the script or tell the person.
export const SCHEDULE_CHECK_FAILURES_BEFORE_WAKE = 3;
// Consecutive ticks whose check could not run at all after which the owner gets an incident. Longer
// than a release takes at the shortest interval, so a deployment alone never raises it.
export const SCHEDULE_CHECK_UNAVAILABLE_BEFORE_INCIDENT = 6;

const CHECK_COMMAND_VARIABLE = "OSINARA_CHECK_COMMAND";
// Far above what the model is shown, far below the runner's limit.
const CHECK_STREAM_MAX_BYTES = 65_536;
// GNU timeout's exit status when the time limit was reached.
const TIMED_OUT_EXIT_CODE = 124;
// A writer killed by a closed pipe: here, the check printed more than the stream allows.
const BROKEN_PIPE_EXIT_CODE = 141;
const TRUNCATED_MARKER = "\n[output truncated]";

export type ScheduleCheckOutcome =
  | { kind: "quiet" }
  | { kind: "fired"; output: string }
  | {
    detail: string;
    errorCode: "AGENT_SCHEDULE_CHECK_FAILED" | "AGENT_SCHEDULE_CHECK_TIMED_OUT";
    exitCode: number;
    kind: "failed";
  };

/** Why a monitor's run woke the agent; `expired` is the last run after the window closed. */
export type ScheduleCheckTrigger = "expired" | "failed" | "fired";

function head(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - TRUNCATED_MARKER.length)}${TRUNCATED_MARKER}`;
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

// PostgreSQL text cannot hold NUL, and a script may print anything.
function storable(text: string): string {
  return text.replaceAll("\u0000", "").trim();
}

function failureDetail(exitCode: number, stderr: string, stdout: string): string {
  // The runner's own timeout note names its outer limit, not the check's, so it is replaced here.
  if (exitCode === TIMED_OUT_EXIT_CODE) return `the check ran longer than ${SCHEDULE_CHECK_TIMEOUT_SECONDS} s and was stopped`;
  if (exitCode === BROKEN_PIPE_EXIT_CODE) return `the check printed more than ${CHECK_STREAM_MAX_BYTES} bytes or lost its output pipe`;
  return tail(stderr === "" ? stdout : stderr, SCHEDULE_CHECK_DETAIL_MAX_LENGTH);
}

export function classifyScheduleCheck(result: { exitCode: number; stderr: string; stdout: string }): ScheduleCheckOutcome {
  const stdout = storable(result.stdout);
  if (result.exitCode === 0) {
    return stdout === "" ? { kind: "quiet" } : { kind: "fired", output: head(stdout, SCHEDULE_CHECK_OUTPUT_MAX_LENGTH) };
  }
  return {
    detail: failureDetail(result.exitCode, storable(result.stderr), stdout),
    errorCode: result.exitCode === TIMED_OUT_EXIT_CODE ? "AGENT_SCHEDULE_CHECK_TIMED_OUT" : "AGENT_SCHEDULE_CHECK_FAILED",
    exitCode: result.exitCode,
    kind: "failed",
  };
}

export function scheduleCheckProcess(command: string): { command: string; env: Record<string, string> } {
  return {
    command: `set -o pipefail; timeout --signal=TERM --kill-after=5s ${SCHEDULE_CHECK_TIMEOUT_SECONDS} ` +
      `bash -c "$${CHECK_COMMAND_VARIABLE}" 2> >(head -c ${CHECK_STREAM_MAX_BYTES} >&2) | head -c ${CHECK_STREAM_MAX_BYTES}`,
    env: { [CHECK_COMMAND_VARIABLE]: command },
  };
}
