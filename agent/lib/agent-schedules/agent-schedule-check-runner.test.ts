/**
 * Monitor check runner tests.
 *
 * Constructs covered:
 * - `createScheduleCheckRunner`: opens the sandbox of the watched conversation's runtime session
 *   with the identity a turn of that chat carries, so the check gets the folders a Bash call there
 *   would get: personal and family in a private chat, family only in a family group.
 * - The script reaches the sandbox only through its environment, and the result is classified.
 */
import { describe, expect, it, vi } from "vitest";

import type { ScheduleCheckTarget } from "./agent-schedule-check-repository.js";
import { createScheduleCheckRunner } from "./agent-schedule-check-runner.js";

const CHECK = "curl -s https://clinic.example/slots | grep ноябрь";

function target(overrides: Partial<ScheduleCheckTarget> = {}): ScheduleCheckTarget {
  return {
    authorUserId: "user-1",
    checkCommand: CHECK,
    checkFailures: 0,
    checkUnavailable: 0,
    checkUntil: new Date("2026-10-30T10:00:00.000Z"),
    familyId: "family-1",
    groupId: null,
    role: "member",
    sandbox: { agentSessionId: "ses-1", applicationSessionId: "app-1", pendingOperation: false, sandboxSessionId: "thread-1" },
    scope: "personal",
    telegramChatId: "101",
    telegramChatType: "private",
    ...overrides,
  };
}

function runner(stdout: string) {
  const run = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout });
  const openSandbox = vi.fn().mockResolvedValue({ run });
  return { openSandbox, run, runCheck: createScheduleCheckRunner({ openSandbox }) };
}

describe("monitor check runner", () => {
  it("checks in a private chat's sandbox as its author with personal and family folders", async () => {
    const { openSandbox, run, runCheck } = runner("открыта");

    await expect(runCheck(target())).resolves.toEqual({ kind: "fired", output: "открыта" });

    const session = openSandbox.mock.calls[0]![0];
    expect(session.id).toBe("ses-1");
    expect(session.auth.current).toEqual({
      attributes: {
        applicationSessionId: "app-1",
        familyId: "family-1",
        memoryScopes: ["personal", "family"],
        role: "member",
        sandboxSessionId: "thread-1",
        telegramChatId: "101",
        telegramChatType: "private",
      },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ env: { OSINARA_CHECK_COMMAND: CHECK } }));
    expect(run.mock.calls[0]![0].command).not.toContain(CHECK);
  });

  it("checks in a family group's sandbox with the family folder only", async () => {
    const { openSandbox, runCheck } = runner("");

    await expect(runCheck(target({
      groupId: "group-1", scope: "family", telegramChatId: "-100200", telegramChatType: "supergroup",
    }))).resolves.toEqual({ kind: "quiet" });

    expect(openSandbox.mock.calls[0]![0].auth.current.attributes).toMatchObject({
      groupId: "group-1",
      groupType: "family_private",
      memoryScopes: ["family"],
    });
  });
});
