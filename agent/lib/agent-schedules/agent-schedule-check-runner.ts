/**
 * Runs a monitor's check in the sandbox of the chat it watches.
 *
 * Exports:
 * - `runScheduleCheckIn`: runs one check in a given sandbox and classifies the result.
 * - `createScheduleCheckRunner`: opens the conversation's sandbox for a target and runs its check.
 *
 * Key constructs:
 * - The sandbox is opened by the same factory as a turn's, from the same verified identity of the
 *   chat, so the check gets exactly the folders and network a Bash call of that chat would get.
 * - A thrown error means the check could not run at all; only a finished process is a result.
 */
import type { SessionAuth, SessionAuthContext } from "../../runtime/context.js";
import type { RuntimeSandboxSession, SandboxSession } from "../../runtime/sandbox/types.js";
import {
  SCHEDULE_CHECK_TIMEOUT_SECONDS,
  type ScheduleCheckOutcome,
  classifyScheduleCheck,
  scheduleCheckProcess,
} from "./agent-schedule-check-contract.js";
import type { ScheduleCheckTarget } from "./agent-schedule-check-repository.js";

// The check ends itself through GNU timeout. This only bounds a runner that stopped answering, and
// it counts from before the container may still have to start, so it leaves room for that too:
// cancelling makes the runner remove the container, which must never cut a working check short.
const RUNNER_SILENCE_MILLISECONDS = (SCHEDULE_CHECK_TIMEOUT_SECONDS + 180) * 1_000;

export async function runScheduleCheckIn(
  sandbox: Pick<SandboxSession, "run">,
  command: string,
): Promise<ScheduleCheckOutcome> {
  const process = scheduleCheckProcess(command);
  const result = await sandbox.run({
    abortSignal: AbortSignal.timeout(RUNNER_SILENCE_MILLISECONDS),
    command: process.command,
    env: process.env,
  });
  return classifyScheduleCheck(result);
}

/** The identity a turn of the watched chat carries, as far as its sandbox mounts depend on it. */
function checkAuth(target: ScheduleCheckTarget): SessionAuthContext {
  const family = target.scope === "family";
  return {
    attributes: {
      applicationSessionId: target.sandbox.applicationSessionId,
      familyId: target.familyId,
      ...(family && target.groupId !== null ? { groupId: target.groupId, groupType: "family_private" } : {}),
      memoryScopes: family ? ["family"] : ["personal", "family"],
      role: target.role,
      sandboxSessionId: target.sandbox.sandboxSessionId,
      telegramChatId: target.telegramChatId,
      telegramChatType: target.telegramChatType,
    },
    authenticator: "telegram",
    principalId: target.authorUserId,
    principalType: "user",
  };
}

export function createScheduleCheckRunner(dependencies: {
  openSandbox(session: { readonly auth: SessionAuth; readonly id: string }): Promise<RuntimeSandboxSession>;
}) {
  return async function runScheduleCheck(target: ScheduleCheckTarget): Promise<ScheduleCheckOutcome> {
    const auth = checkAuth(target);
    const sandbox = await dependencies.openSandbox({
      auth: { current: auth, initiator: auth },
      id: target.sandbox.agentSessionId,
    });
    return await runScheduleCheckIn(sandbox, target.checkCommand);
  };
}
