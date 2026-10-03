import { afterEach, describe, expect, it, vi } from "vitest";

import { cronMatches, startScheduler } from "./scheduler.js";

const at = (text: string) => new Date(text);

describe("cron matching", () => {
  it("runs a minute schedule every minute and the update check at 00, 06, 12 and 18 o'clock", () => {
    expect(cronMatches("* * * * *", at("2026-10-02T13:47:00"))).toBe(true);
    const sixHourly = Array.from({ length: 24 }, (_, hour) => hour)
      .filter((hour) => cronMatches("0 */6 * * *", at(`2026-10-02T${String(hour).padStart(2, "0")}:00:00`)));
    expect(sixHourly).toEqual([0, 6, 12, 18]);
    expect(cronMatches("0 */6 * * *", at("2026-10-02T06:01:00"))).toBe(false);
  });

  it("reads ranges, steps, lists and either day field", () => {
    expect(cronMatches("15-45/15 9,17 * * *", at("2026-10-02T17:30:00"))).toBe(true);
    expect(cronMatches("15-45/15 9,17 * * *", at("2026-10-02T17:31:00"))).toBe(false);
    // 2026-10-02 is a Friday: with both day fields set, a Friday matches although it is not the 1st.
    expect(cronMatches("0 0 1 * 5", at("2026-10-02T00:00:00"))).toBe(true);
    expect(cronMatches("0 0 * * 7", at("2026-10-04T00:00:00"))).toBe(true);
  });

  it("refuses an expression it cannot read, and two schedules under one name", () => {
    expect(() => cronMatches("61 * * * *", new Date())).toThrow("AGENT_SCHEDULE_CRON_INVALID");
    expect(() => cronMatches("* * * *", new Date())).toThrow("AGENT_SCHEDULE_CRON_INVALID");
    expect(() => startScheduler({ schedules: [{ cron: "x * * * *", name: "broken", run: () => {} }] })).toThrow("AGENT_SCHEDULE_CRON_INVALID");
    expect(() => startScheduler({ schedules: [{ cron: "* * * * *", name: "twice", run: () => {} }, { cron: "0 * * * *", name: "twice", run: () => {} }] }))
      .toThrow("AGENT_SCHEDULE_NAME_DUPLICATE");
  });
});

describe("minute scheduler", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("fires at the start of each minute and waits on stop for the work it started", async () => {
    vi.useFakeTimers({ now: at("2026-10-02T13:47:30") });
    const minutes: string[] = [];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const scheduler = startScheduler({
      schedules: [
        { cron: "* * * * *", name: "every-minute", run: ({ waitUntil }) => {
          minutes.push(new Date().toISOString());
          if (minutes.length === 2) waitUntil(pending);
        } },
        { cron: "0 */6 * * *", name: "six-hourly", run: () => { throw new Error("must not run at 13:48"); } },
      ],
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(minutes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(minutes).toEqual([at("2026-10-02T13:48:00").toISOString(), at("2026-10-02T13:49:00").toISOString()]);

    let stopped = false;
    const stopping = scheduler.stop(5_000).then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(minutes).toHaveLength(2);
  });

  it("skips a schedule's minute while its previous cycle still runs", async () => {
    vi.useFakeTimers({ now: at("2026-10-02T13:47:59") });
    const infos = vi.spyOn(console, "info").mockImplementation(() => {});
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => { finish = resolve; });
    const runs: string[] = [];
    const scheduler = startScheduler({
      schedules: [
        { cron: "* * * * *", name: "slow", run: ({ waitUntil }) => { runs.push("slow"); waitUntil(slow); } },
        { cron: "* * * * *", name: "quick", run: () => { runs.push("quick"); } },
      ],
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(60_000);
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.stop(10);

    expect(runs).toEqual(["slow", "quick", "quick", "slow", "quick"]);
    expect(infos.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { code: "AGENT_SCHEDULE_CYCLE_SKIPPED", schedule: "slow" },
    ]);
  });

  it("logs a schedule that throws and keeps running the others", async () => {
    vi.useFakeTimers({ now: at("2026-10-02T13:47:59") });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran = vi.fn();
    const scheduler = startScheduler({
      schedules: [
        { cron: "* * * * *", name: "broken", run: () => { throw new Error("boom"); } },
        { cron: "* * * * *", name: "healthy", run: ran },
      ],
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.stop(10);

    expect(ran).toHaveBeenCalledOnce();
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { code: "AGENT_SCHEDULE_RUN_FAILED", error: "boom", schedule: "broken" },
    ]);
  });
});
