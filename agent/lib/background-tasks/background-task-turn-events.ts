/**
 * What a background task's own turn records while it runs (#519).
 *
 * Exports:
 * - `recordBackgroundTaskStep`: before each model step of a task's turn — the corrections of the previous
 *   step count as seen, the step is counted and the clock moves; a task at its step limit, or one that no
 *   longer runs, is cancelled before the model is paid.
 * - `backgroundTaskObserver`: the task channel's observer — binds the session, keeps the task's latest
 *   words as its note, refuses any request for a person.
 *
 * The turn's outcome is not handled here: the task dispatcher runs the turn and reads it.
 */
import type { TurnObserver } from "../../runtime/turn/run-turn.js";
import { TurnCancelledError } from "../../runtime/turn/model-errors.js";
import type { StepStartContext } from "../../runtime/agent-definition.js";
import { AppError } from "../app-error.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { BACKGROUND_TASK_NOTE_MAX_LENGTH, BACKGROUND_TASK_STEP_LIMIT } from "./background-task-config.js";
import { backgroundTaskMessageRepository } from "./background-task-message-repository.js";
import { backgroundTaskRepository } from "./background-task-repository.js";
import { backgroundTaskIdOf, isBackgroundTaskSummaryTurn } from "./background-task-session.js";

export interface BackgroundTaskStepDependencies {
  readonly messages: Pick<typeof backgroundTaskMessageRepository, "markDelivered">;
  readonly now: () => Date;
  readonly tasks: Pick<typeof backgroundTaskRepository, "find" | "recordStep">;
}

const DEFAULT_STEP_DEPENDENCIES: BackgroundTaskStepDependencies = {
  messages: backgroundTaskMessageRepository,
  now: () => new Date(),
  tasks: backgroundTaskRepository,
};

export async function recordBackgroundTaskStep(
  ctx: Pick<StepStartContext, "session">,
  dependencies: BackgroundTaskStepDependencies = DEFAULT_STEP_DEPENDENCIES,
): Promise<void> {
  const taskId = backgroundTaskIdOf(ctx);
  // The summary turn is not work: it is not counted and nothing cuts it but its own deadline.
  if (taskId === null || isBackgroundTaskSummaryTurn(ctx)) return;
  const now = dependencies.now();
  await dependencies.messages.markDelivered(taskId, ctx.session.turn.id, now);
  const current = await dependencies.tasks.find(taskId);
  // Cancelled, not failed: the dispatcher reads why from the task and writes the outcome itself.
  if (current === null || (current.state !== "running" && current.state !== "stopping")) throw new TurnCancelledError();
  if (current.steps >= BACKGROUND_TASK_STEP_LIMIT) throw new TurnCancelledError();
  await dependencies.tasks.recordStep(taskId, now);
}

/** One line of the model's own words, cut to the note's length. */
export function backgroundTaskNote(text: string): string | null {
  const line = text.replace(/\s+/gu, " ").trim();
  if (!line) return null;
  return line.length <= BACKGROUND_TASK_NOTE_MAX_LENGTH ? line : `${line.slice(0, BACKGROUND_TASK_NOTE_MAX_LENGTH - 1)}…`;
}

export function backgroundTaskObserver(
  dependencies: {
    readonly sessions: Pick<typeof sessionRepository, "bindAgentSession">;
    readonly tasks: Pick<typeof backgroundTaskRepository, "recordNote">;
  } = { sessions: sessionRepository, tasks: backgroundTaskRepository },
): TurnObserver {
  return {
    async turnStarted(turn) {
      // The retired session's journal is deleted with it only when the session knows its runtime session.
      const appSessionId = turn.auth.current?.attributes.applicationSessionId;
      if (typeof appSessionId !== "string") {
        throw new AppError("AGENT_SESSION_CONTEXT_INVALID", "Не удалось определить текущий контекст разговора");
      }
      await dependencies.sessions.bindAgentSession(appSessionId, turn.sessionId);
    },
    async stepText({ message, turn }) {
      const taskId = backgroundTaskIdOf({ session: { auth: turn.auth } });
      const note = message === null ? null : backgroundTaskNote(message);
      if (taskId === null || note === null) return;
      await dependencies.tasks.recordNote(taskId, note);
    },
    async toolsStarted() {},
    async inputRequested(event) {
      // A tool of a task's surface never asks; should one ask, nobody could answer it.
      throw new AppError("AGENT_BACKGROUND_TASK_NEEDS_PERSON", "Это действие требует подтверждения человека: сделай его в разговоре", {
        details: { turnId: event.turn.id },
      });
    },
    async turnFinished() {},
  };
}
