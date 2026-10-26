/**
 * Monitor check contract tests.
 *
 * Constructs covered:
 * - `classifyScheduleCheck`: empty output is quiet, printed text is the event, a non-zero exit is a
 *   broken check, and a timed-out check is told apart from other failures.
 * - Output reaches the model bounded; a failure keeps the end of stderr, where errors are.
 * - `scheduleCheckProcess`: the check runs through an environment variable under its own timeout,
 *   so no quoting of the model's script is needed, and its output is cut at the source.
 * - NUL bytes, which PostgreSQL text cannot store, never reach the outcome.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  SCHEDULE_CHECK_DETAIL_MAX_LENGTH,
  SCHEDULE_CHECK_OUTPUT_MAX_LENGTH,
  SCHEDULE_CHECK_TIMEOUT_SECONDS,
  classifyScheduleCheck,
  scheduleCheckProcess,
} from "./agent-schedule-check-contract.js";

describe("monitor check contract", () => {
  it("treats empty or blank output of a successful check as nothing yet", () => {
    expect(classifyScheduleCheck({ exitCode: 0, stderr: "curl progress", stdout: "" })).toEqual({ kind: "quiet" });
    expect(classifyScheduleCheck({ exitCode: 0, stderr: "", stdout: " \n\t\n" })).toEqual({ kind: "quiet" });
  });

  it("wakes the agent with what the check printed", () => {
    expect(classifyScheduleCheck({ exitCode: 0, stderr: "", stdout: "\nЗапись на 12 ноября открыта\n" }))
      .toEqual({ kind: "fired", output: "Запись на 12 ноября открыта" });
  });

  it("reports a broken check with its exit code and the end of stderr", () => {
    const stderr = `${"x".repeat(5_000)}\nTraceback: KeyError 'price'`;
    const outcome = classifyScheduleCheck({ exitCode: 1, stderr, stdout: "частичный вывод" });

    expect(outcome).toMatchObject({ errorCode: "AGENT_SCHEDULE_CHECK_FAILED", exitCode: 1, kind: "failed" });
    expect(outcome.kind === "failed" && outcome.detail.endsWith("Traceback: KeyError 'price'")).toBe(true);
    expect(outcome.kind === "failed" && outcome.detail.length).toBeLessThanOrEqual(SCHEDULE_CHECK_DETAIL_MAX_LENGTH);
  });

  it("falls back to stdout when a failed check wrote nothing to stderr", () => {
    expect(classifyScheduleCheck({ exitCode: 2, stderr: "", stdout: "usage: grep" }))
      .toMatchObject({ detail: "usage: grep", kind: "failed" });
  });

  it("tells a timed-out check apart and names the check's own limit", () => {
    expect(classifyScheduleCheck({ exitCode: 124, stderr: "AGENT_SANDBOX_RUNNER_PROCESS_TIMED_OUT: Command exceeded 120000 ms", stdout: "" }))
      .toEqual({
        detail: `the check ran longer than ${SCHEDULE_CHECK_TIMEOUT_SECONDS} s and was stopped`,
        errorCode: "AGENT_SCHEDULE_CHECK_TIMED_OUT",
        exitCode: 124,
        kind: "failed",
      });
  });

  it("explains a check cut off for printing too much", () => {
    expect(classifyScheduleCheck({ exitCode: 141, stderr: "", stdout: "x".repeat(65_536) }))
      .toMatchObject({ detail: expect.stringContaining("65536 bytes"), errorCode: "AGENT_SCHEDULE_CHECK_FAILED", kind: "failed" });
  });

  it("drops NUL bytes PostgreSQL cannot store", () => {
    expect(classifyScheduleCheck({ exitCode: 0, stderr: "", stdout: "ок\u0000\u0000" })).toEqual({ kind: "fired", output: "ок" });
    expect(classifyScheduleCheck({ exitCode: 0, stderr: "", stdout: "\u0000" })).toEqual({ kind: "quiet" });
  });

  it("classifies every result into exactly one bounded outcome", () => {
    // The script is model-written and its output arbitrary: any result must map to one outcome,
    // the event only on a clean exit with visible text, and never past the model-facing bound.
    // Arbitrary text around a padding length keeps outputs past the bound cheap to shrink.
    const output = fc.tuple(fc.string({ maxLength: 40, unit: "grapheme" }), fc.nat({ max: 4_100 }), fc.boolean())
      .map(([text, padding, before]) => before ? `${"ж".repeat(padding)}${text}` : `${text}${"ж".repeat(padding)}`);
    fc.assert(fc.property(
      fc.integer({ max: 255, min: 0 }),
      output,
      output,
      (exitCode, stdout, stderr) => {
        const outcome = classifyScheduleCheck({ exitCode, stderr, stdout });
        const visible = stdout.replaceAll("\u0000", "").trim();
        expect(outcome.kind === "fired").toBe(exitCode === 0 && visible !== "");
        expect(outcome.kind === "quiet").toBe(exitCode === 0 && visible === "");
        if (outcome.kind === "fired") {
          expect(outcome.output.length).toBeLessThanOrEqual(SCHEDULE_CHECK_OUTPUT_MAX_LENGTH);
          if (visible.length <= SCHEDULE_CHECK_OUTPUT_MAX_LENGTH) expect(outcome.output).toBe(visible);
        }
        if (outcome.kind === "failed") {
          expect(outcome.exitCode).toBe(exitCode);
          expect(outcome.detail.length).toBeLessThanOrEqual(SCHEDULE_CHECK_DETAIL_MAX_LENGTH);
          expect(outcome.detail).not.toContain("\u0000");
        }
      },
    ), { examples: [[0, "", ""], [0, "x".repeat(4_001), ""], [124, "", ""], [1, "", ""], [0, "\u0000", ""], [2, "", "\u0000ошибка"]] });
  });

  it("passes the script through an environment variable under its own timeout", () => {
    const script = `curl -s 'https://example.com/?a=1&b="2"' | grep -q "Запись открыта" && echo открыта`;
    const process = scheduleCheckProcess(script);

    expect(process.command).toBe(
      `set -o pipefail; timeout --signal=TERM --kill-after=5s ${SCHEDULE_CHECK_TIMEOUT_SECONDS} ` +
        "bash -c \"$OSINARA_CHECK_COMMAND\" 2> >(head -c 65536 >&2) | head -c 65536",
    );
    expect(process.env).toEqual({ OSINARA_CHECK_COMMAND: script });
  });
});
