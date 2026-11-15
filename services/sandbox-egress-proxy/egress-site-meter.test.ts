/**
 * Minute tally of sites the egress proxy opened and could not reach (#499).
 *
 * A single site that does not open is not an alert; a whole day of attempts with nothing opened is
 * (OsinaraSitesUnreachable). The alert reads this tally, so it must arrive every minute as one
 * JSON line, quiet minutes included, and count each minute only once.
 *
 * Constructs covered:
 * - Each interval writes one routine line with the opened and failed counts since the previous one.
 * - A quiet interval still writes its line, with zeros.
 * - Stopping the meter stops the lines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SANDBOX_EGRESS_ROUTINE_CODES, SANDBOX_EGRESS_SITE_METRICS_CODE } from "./egress-log.js";
import { createEgressSiteMeter } from "./egress-site-meter.js";

const INTERVAL_MILLISECONDS = 60_000;

type Logged = { stream: "error" | "info"; text: string };

let lines: Logged[];

function records(): Array<Record<string, unknown>> {
  return lines.map(({ text }) => JSON.parse(text) as Record<string, unknown>);
}

describe("egress site meter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lines = [];
    vi.spyOn(console, "info").mockImplementation((text: string) => { lines.push({ stream: "info", text }); });
    vi.spyOn(console, "error").mockImplementation((text: string) => { lines.push({ stream: "error", text }); });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes what opened and what failed since the previous line, once per interval", () => {
    const meter = createEgressSiteMeter();
    const stop = meter.start(INTERVAL_MILLISECONDS);

    meter.opened();
    meter.opened();
    meter.failed();
    vi.advanceTimersByTime(INTERVAL_MILLISECONDS);
    meter.failed();
    vi.advanceTimersByTime(INTERVAL_MILLISECONDS);
    stop();

    expect(records()).toEqual([
      { code: SANDBOX_EGRESS_SITE_METRICS_CODE, failed: 1, opened: 2 },
      { code: SANDBOX_EGRESS_SITE_METRICS_CODE, failed: 1, opened: 0 },
    ]);
    // A tally is information: the burst alert must not count it (monitoring-alert-rules.test.ts).
    expect(lines.every((line) => line.stream === "info")).toBe(true);
    expect(SANDBOX_EGRESS_ROUTINE_CODES).toContain(SANDBOX_EGRESS_SITE_METRICS_CODE);
  });

  it("writes a quiet interval too, so the alert knows the proxy was counting", () => {
    const meter = createEgressSiteMeter();
    const stop = meter.start(INTERVAL_MILLISECONDS);

    vi.advanceTimersByTime(INTERVAL_MILLISECONDS);
    stop();

    expect(records()).toEqual([{ code: SANDBOX_EGRESS_SITE_METRICS_CODE, failed: 0, opened: 0 }]);
  });

  it("writes nothing more once stopped", () => {
    const meter = createEgressSiteMeter();
    const stop = meter.start(INTERVAL_MILLISECONDS);

    stop();
    meter.opened();
    vi.advanceTimersByTime(3 * INTERVAL_MILLISECONDS);

    expect(lines).toEqual([]);
  });
});
