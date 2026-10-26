/**
 * Monitor tick decision tests.
 *
 * Constructs covered:
 * - `createScheduleCheckStep`: nothing yet plans the next tick, the event wakes the agent with its
 *   output, broken checks wake it only after several in a row, and the tick due at the end of the
 *   window always wakes it with the result of the watch.
 * - A check that could not run at all is skipped without counting as the script's failure.
 * - A conversation the chat left behind runs no check; an author who left fails the claim.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import type { ScheduleCheckOutcome } from "./agent-schedule-check-contract.js";
import type { ScheduleCheckTarget } from "./agent-schedule-check-repository.js";
import { createScheduleCheckStep } from "./agent-schedule-check-step.js";

const NOW = new Date("2026-10-27T10:00:00.000Z");
const tick = { id: "schedule-1", leaseToken: "lease-1", nextRunAt: "2026-10-27T10:00:00.000Z", runId: "run-1" };

function target(overrides: Partial<ScheduleCheckTarget> = {}): ScheduleCheckTarget {
  return {
    authorUserId: "user-1",
    checkCommand: "curl -s https://clinic.example/slots | grep -q ноябрь && echo открыта",
    checkFailures: 0,
    checkUnavailable: 0,
    checkUntil: new Date("2026-10-30T10:00:00.000Z"),
    familyId: "family-1",
    groupId: null,
    role: "owner",
    sandbox: { agentSessionId: "ses-1", applicationSessionId: "app-1", pendingOperation: false, sandboxSessionId: "thread-1" },
    scope: "personal",
    telegramChatId: "101",
    telegramChatType: "private",
    ...overrides,
  };
}

function step(loaded: ScheduleCheckTarget | null | Error, outcome: ScheduleCheckOutcome | Error) {
  const repository = {
    finishTick: vi.fn().mockResolvedValue(undefined),
    loadTarget: loaded instanceof Error ? vi.fn().mockRejectedValue(loaded) : vi.fn().mockResolvedValue(loaded),
    wake: vi.fn().mockResolvedValue("queued"),
  };
  const runCheck = outcome instanceof Error ? vi.fn().mockRejectedValue(outcome) : vi.fn().mockResolvedValue(outcome);
  const failClaim = vi.fn().mockResolvedValue(undefined);
  const check = createScheduleCheckStep({ failClaim, now: () => NOW, repository, runCheck });
  return { check, failClaim, repository, runCheck };
}

const broken: ScheduleCheckOutcome = {
  detail: "curl: (6) Could not resolve host",
  errorCode: "AGENT_SCHEDULE_CHECK_FAILED",
  exitCode: 6,
  kind: "failed",
};

describe("monitor tick", () => {
  it("plans the next tick when nothing happened yet", async () => {
    const { check, repository } = step(target({ checkFailures: 2 }), { kind: "quiet" });

    await expect(check(tick)).resolves.toBe("waiting");

    expect(repository.finishTick).toHaveBeenCalledWith(tick, { checked: true, errorCode: null, failures: 0, unavailable: 0 }, NOW);
    expect(repository.wake).not.toHaveBeenCalled();
  });

  it("wakes the agent with what the check printed", async () => {
    const { check, repository } = step(target({ checkFailures: 1 }), { kind: "fired", output: "Запись на 12 ноября открыта" });

    await expect(check(tick)).resolves.toBe("queued");

    expect(repository.wake).toHaveBeenCalledWith(
      tick,
      { output: "Запись на 12 ноября открыта", trigger: "fired" },
      { checked: true, errorCode: null, failures: 0, unavailable: 0 },
      NOW,
    );
    expect(repository.finishTick).not.toHaveBeenCalled();
  });

  it("counts a broken check without waking the agent before the third in a row", async () => {
    const { check, repository } = step(target({ checkFailures: 1 }), broken);

    await expect(check(tick)).resolves.toBe("waiting");

    expect(repository.finishTick).toHaveBeenCalledWith(
      tick, { checked: true, errorCode: "AGENT_SCHEDULE_CHECK_FAILED", failures: 2, unavailable: 0 }, NOW,
    );
  });

  it("wakes the agent on the third broken check in a row with the exit code and the error", async () => {
    const { check, repository } = step(target({ checkFailures: 2 }), broken);

    await expect(check(tick)).resolves.toBe("queued");

    expect(repository.wake).toHaveBeenCalledWith(
      tick,
      { output: "exit code 6: curl: (6) Could not resolve host", trigger: "failed" },
      // The counter starts over, so a script left broken wakes the agent again only three ticks later.
      { checked: true, errorCode: "AGENT_SCHEDULE_CHECK_FAILED", failures: 0, unavailable: 0 },
      NOW,
    );
  });

  it("ends the watch at the tick due at the end of the window", async () => {
    const last = { ...tick, nextRunAt: "2026-10-30T10:00:00.000Z" };
    const quiet = step(target(), { kind: "quiet" });
    const failing = step(target({ checkFailures: 1 }), broken);
    const fired = step(target(), { kind: "fired", output: "Открыта" });

    await quiet.check(last);
    await failing.check(last);
    await fired.check(last);

    expect(quiet.repository.wake).toHaveBeenCalledWith(
      last, { output: null, trigger: "expired" }, { checked: true, errorCode: null, failures: 0, unavailable: 0 }, NOW,
    );
    expect(failing.repository.wake).toHaveBeenCalledWith(
      last,
      { output: "exit code 6: curl: (6) Could not resolve host", trigger: "expired" },
      { checked: true, errorCode: "AGENT_SCHEDULE_CHECK_FAILED", failures: 2, unavailable: 0 },
      NOW,
    );
    // An event found on the last tick is reported as the event; the run is still the last one.
    expect(fired.repository.wake).toHaveBeenCalledWith(
      last, { output: "Открыта", trigger: "fired" }, { checked: true, errorCode: null, failures: 0, unavailable: 0 }, NOW,
    );
  });

  it("skips a tick whose check could not run without counting it against the script", async () => {
    const { check, repository } = step(target({ checkFailures: 1, checkUnavailable: 4 }), new Error("AGENT_SANDBOX_RUNNER_UNAVAILABLE"));

    await expect(check(tick)).resolves.toBe("waiting");

    expect(repository.finishTick).toHaveBeenCalledWith(
      tick, { checked: false, errorCode: "AGENT_SCHEDULE_CHECK_UNAVAILABLE", failures: 1, unavailable: 5 }, NOW,
    );
  });

  it("still reports the end of the window when the last check could not run", async () => {
    const last = { ...tick, nextRunAt: "2026-10-30T10:00:00.000Z" };
    const { check, repository } = step(target(), new Error("runner down"));

    await check(last);

    expect(repository.wake).toHaveBeenCalledWith(
      last,
      { output: "the last check could not run: AGENT_SCHEDULE_CHECK_UNAVAILABLE", trigger: "expired" },
      { checked: false, errorCode: "AGENT_SCHEDULE_CHECK_UNAVAILABLE", failures: 0, unavailable: 1 },
      NOW,
    );
  });

  it("runs no check for a conversation the chat left behind", async () => {
    const { check, runCheck } = step(null, { kind: "quiet" });

    await expect(check(tick)).resolves.toBe("parked");

    expect(runCheck).not.toHaveBeenCalled();
  });

  it("fails the claim when the author left the family", async () => {
    const { check, failClaim, runCheck } = step(
      new AppError("AGENT_SCHEDULE_DESTINATION_REVOKED", "Автор монитора больше не состоит в семье"),
      { kind: "quiet" },
    );

    await expect(check(tick)).resolves.toBe("failed");

    expect(failClaim).toHaveBeenCalledWith(tick, "AGENT_SCHEDULE_DESTINATION_REVOKED");
    expect(runCheck).not.toHaveBeenCalled();
  });
});
