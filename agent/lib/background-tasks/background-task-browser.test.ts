/**
 * Closing a background task's browser when the task ends (#529).
 *
 * Constructs covered:
 * - The command closes only the task's own listed sessions, in running compute only.
 * - A stopped or removed sandbox has no browser left: nothing to do.
 * - A failed close is reported with its own code; an invalid task id never reaches the shell.
 */
import { describe, expect, it, vi } from "vitest";

import { backgroundTaskBrowserSession, closeBackgroundTaskBrowser } from "./background-task-browser.js";

const TASK = { id: "7", sandboxSessionId: "972f65fb-34d3-4a4d-bfed-7095111f7dfd" };

function runner(result: Promise<{ exitCode: number; stderr: string; stdout: string }>) {
  return { run: vi.fn(() => result.then((value) => ({ ...value, processId: "p1" }))) };
}

describe("closeBackgroundTaskBrowser", () => {
  it("closes the task's own sessions in the chat's running sandbox, never waking a stopped one", async () => {
    const client = runner(Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }));
    await closeBackgroundTaskBrowser(client, TASK);

    expect(backgroundTaskBrowserSession("7")).toBe("bg-7");
    expect(client.run).toHaveBeenCalledOnce();
    const [sessionId, request] = client.run.mock.calls[0] as unknown as [string, { command: string; ifRunning: true }];
    expect(sessionId).toBe(TASK.sandboxSessionId);
    expect(request.ifRunning).toBe(true);
    // Only listed sessions: `close` on an absent session starts a new browser daemon.
    expect(request.command).toContain("agent-browser session list --json");
    expect(request.command).toContain("bg-7|bg-7-*)");
    expect(request.command).not.toMatch(/osinara|close --all/u);
  });

  it("has nothing to do when the sandbox is stopped or gone: the browser went with it", async () => {
    // The runner answers both with this code when only running compute was asked for.
    const client = runner(Promise.reject(new Error("AGENT_SANDBOX_RUNNER_SESSION_NOT_RUNNING: Sandbox is stopped (HTTP 409)")));
    await expect(closeBackgroundTaskBrowser(client, TASK)).resolves.toBeUndefined();
  });

  it("reports a close that failed, and passes any other runner failure on", async () => {
    await expect(closeBackgroundTaskBrowser(runner(Promise.resolve({ exitCode: 1, stderr: "daemon not responding", stdout: "" })), TASK))
      .rejects.toThrow(/AGENT_BACKGROUND_TASK_BROWSER_CLOSE_FAILED.*daemon not responding/u);
    await expect(closeBackgroundTaskBrowser(runner(Promise.reject(new Error("AGENT_SANDBOX_RUNNER_OPERATION_FAILED: x (HTTP 500)"))), TASK))
      .rejects.toThrow("AGENT_SANDBOX_RUNNER_OPERATION_FAILED");
  });

  it("refuses a task id that is not a number before anything reaches the shell", async () => {
    const client = runner(Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }));
    await expect(closeBackgroundTaskBrowser(client, { ...TASK, id: "7; rm -rf /" })).rejects.toThrow("AGENT_BACKGROUND_TASK_ID_INVALID");
    expect(client.run).not.toHaveBeenCalled();
  });
});
