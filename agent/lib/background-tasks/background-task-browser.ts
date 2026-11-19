/**
 * A background task's browser in the chat's shared sandbox, and closing it when the task ends (#529).
 *
 * Exports:
 * - `backgroundTaskBrowserSession`: the agent-browser session a task works in, apart from the main agent's.
 * - `closeBackgroundTaskBrowser`: closes the task's sessions in the chat's sandbox if it is running.
 *
 * Key constructs:
 * - One Chromium takes most of the sandbox's process room and up to its whole memory. A task's browser left
 *   behind on 17.11 held about 2 GB for over an hour after the task ended, so the system closes it instead
 *   of waiting for agent-browser's idle timeout.
 * - Only the sessions agent-browser lists are closed: `close` on an absent session starts a new daemon.
 * - A stopped sandbox is not woken for this: its browser stopped with it.
 */
import { AppError } from "../app-error.js";
import type { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import type { BackgroundTask } from "./background-task-records.js";

// Closing a few sessions takes seconds; a daemon that does not answer must not hold the dispatcher.
const CLOSE_TIMEOUT_MS = 30_000;
// The runner's answer for a sandbox that is stopped or absent when only running compute was asked for.
const SANDBOX_NOT_RUNNING = /^AGENT_SANDBOX_RUNNER_SESSION_NOT_RUNNING:/u;

export function backgroundTaskBrowserSession(taskId: string): string {
  return `bg-${taskId}`;
}

function closeCommand(taskId: string): string {
  const session = backgroundTaskBrowserSession(taskId);
  return [
    "set -o pipefail",
    "agent-browser session list --json | jq -r '.data.sessions[]' | while IFS= read -r name; do",
    `  case "$name" in ${session}|${session}-*) agent-browser --session "$name" close >/dev/null || exit 1 ;; esac`,
    "done",
  ].join("\n");
}

export async function closeBackgroundTaskBrowser(
  runner: Pick<SandboxRunnerClient, "run">,
  task: Pick<BackgroundTask, "id" | "sandboxSessionId">,
): Promise<void> {
  // The id goes into a shell command: it is the table's bigint, and nothing else may reach the shell.
  if (!/^\d+$/u.test(task.id)) {
    throw new AppError("AGENT_BACKGROUND_TASK_ID_INVALID", `Неверный номер фоновой задачи: ${task.id}`);
  }
  let result: Awaited<ReturnType<SandboxRunnerClient["run"]>>;
  try {
    result = await runner.run(task.sandboxSessionId, { command: closeCommand(task.id), ifRunning: true, timeoutMs: CLOSE_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof Error && SANDBOX_NOT_RUNNING.test(error.message)) return;
    throw error;
  }
  if (result.exitCode !== 0) {
    throw new AppError(
      "AGENT_BACKGROUND_TASK_BROWSER_CLOSE_FAILED",
      `Не удалось закрыть браузер фоновой задачи ${task.id} (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}
