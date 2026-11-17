/**
 * Background task step accounting (#519).
 *
 * Constructs covered:
 * - Each model step of a task's turn first marks the corrections of the previous step as seen, then counts.
 * - At the step limit, or when the task no longer runs, the step is cancelled before the model is paid.
 * - The summary turn is not counted; other turns are not touched at all.
 * - The note is the model's latest words on one line, cut to its length.
 */
import { describe, expect, it, vi } from "vitest";

import type { SessionAuth } from "../../runtime/context.js";
import { TurnCancelledError } from "../../runtime/turn/model-errors.js";
import { BACKGROUND_TASK_NOTE_MAX_LENGTH, BACKGROUND_TASK_STEP_LIMIT } from "./background-task-config.js";
import type { BackgroundTask } from "./background-task-records.js";
import { backgroundTaskNote, recordBackgroundTaskStep } from "./background-task-turn-events.js";

const NOW = new Date("2026-11-16T12:00:00.000Z");

function context(attributes: Record<string, string>) {
  const auth: SessionAuth = {
    current: { attributes, authenticator: "telegram", principalId: "user-1", principalType: "user" },
    initiator: null,
  };
  return { session: { auth, id: "session-1", turn: { id: "turn-1", kind: "background" as const, sequence: 1 } } };
}

function dependencies(task: Partial<BackgroundTask> | null) {
  return {
    messages: { markDelivered: vi.fn().mockResolvedValue(0) },
    now: () => NOW,
    tasks: {
      find: vi.fn().mockResolvedValue(task === null ? null : { state: "running", steps: 3, ...task }),
      recordStep: vi.fn().mockResolvedValue(null),
    },
  };
}

describe("background task step accounting", () => {
  it("marks the previous corrections as seen and counts the step", async () => {
    const deps = dependencies({});
    await recordBackgroundTaskStep(context({ backgroundTaskId: "7" }), deps);
    expect(deps.messages.markDelivered).toHaveBeenCalledWith("7", "turn-1", NOW);
    expect(deps.tasks.recordStep).toHaveBeenCalledWith("7", NOW);
  });

  it("cancels the step at the limit without counting it", async () => {
    const deps = dependencies({ steps: BACKGROUND_TASK_STEP_LIMIT });
    await expect(recordBackgroundTaskStep(context({ backgroundTaskId: "7" }), deps)).rejects.toBeInstanceOf(TurnCancelledError);
    expect(deps.tasks.recordStep).not.toHaveBeenCalled();
  });

  it("cancels the step of a task that no longer runs", async () => {
    for (const task of [null, { state: "stopped" as const }]) {
      const deps = dependencies(task);
      await expect(recordBackgroundTaskStep(context({ backgroundTaskId: "7" }), deps)).rejects.toBeInstanceOf(TurnCancelledError);
    }
  });

  it("keeps a stopping task's step, so the step under way can still be cut by the dispatcher", async () => {
    const deps = dependencies({ state: "stopping" });
    await recordBackgroundTaskStep(context({ backgroundTaskId: "7" }), deps);
    expect(deps.tasks.recordStep).toHaveBeenCalled();
  });

  it("leaves the summary turn and every other turn alone", async () => {
    const turns: Record<string, string>[] = [{ backgroundTaskId: "7", backgroundTaskSummary: "true" }, { telegramChatId: "42" }];
    for (const attributes of turns) {
      const deps = dependencies({});
      await recordBackgroundTaskStep(context(attributes), deps);
      expect(deps.tasks.find).not.toHaveBeenCalled();
      expect(deps.messages.markDelivered).not.toHaveBeenCalled();
    }
  });

  it("keeps the model's latest words on one line within the note's length", () => {
    expect(backgroundTaskNote("  Прочитал 14\nфайлов  ")).toBe("Прочитал 14 файлов");
    expect(backgroundTaskNote("   ")).toBeNull();
    const long = backgroundTaskNote("а".repeat(BACKGROUND_TASK_NOTE_MAX_LENGTH + 50));
    expect(long).toHaveLength(BACKGROUND_TASK_NOTE_MAX_LENGTH);
    expect(long!.endsWith("…")).toBe(true);
  });
});
