/**
 * Which turns are a background task's, and which answer a task's event in the chat (#519).
 *
 * Exports:
 * - `BACKGROUND_TASK_CHANNEL_KIND`: the channel a task's own turns run in; nothing is delivered there.
 * - `BACKGROUND_TASK_ID_ATTRIBUTE`, `BACKGROUND_TASK_SUMMARY_ATTRIBUTE`, `BACKGROUND_TASK_EVENT_ATTRIBUTE`:
 *   trusted auth attributes the application sets when it builds those turns.
 * - `backgroundTaskToken`: the continuation token of a task's session, one session per task.
 * - `backgroundTaskIdOf`, `isBackgroundTaskSession`, `isBackgroundTaskSummaryTurn`: read the task's own turns.
 * - `backgroundTaskEventIdOf`: the event a turn of the chat answers, or null.
 *
 * The marks come only from auth the application built from verified records: a model cannot set them.
 */
import type { SessionAuth } from "../../runtime/context.js";

export const BACKGROUND_TASK_CHANNEL_KIND = "background-task";
export const BACKGROUND_TASK_ID_ATTRIBUTE = "backgroundTaskId";
/** The last short turn of a stopped or cut-off task: no tools, only what it managed to do. */
export const BACKGROUND_TASK_SUMMARY_ATTRIBUTE = "backgroundTaskSummary";
export const BACKGROUND_TASK_EVENT_ATTRIBUTE = "backgroundTaskEventId";

type AuthCarrier = { readonly session: { readonly auth: SessionAuth } };

export function backgroundTaskToken(taskId: string): string {
  return `background-task:${taskId}`;
}

function attribute(ctx: AuthCarrier, name: string): string | null {
  // A task's session is opened by the task's own auth, so its initiator carries the mark too.
  const value = ctx.session.auth.current?.attributes[name] ?? ctx.session.auth.initiator?.attributes[name];
  return typeof value === "string" && value ? value : null;
}

export function backgroundTaskIdOf(ctx: AuthCarrier): string | null {
  return attribute(ctx, BACKGROUND_TASK_ID_ATTRIBUTE);
}

export function isBackgroundTaskSession(ctx: AuthCarrier): boolean {
  return backgroundTaskIdOf(ctx) !== null;
}

export function isBackgroundTaskSummaryTurn(ctx: AuthCarrier): boolean {
  return ctx.session.auth.current?.attributes[BACKGROUND_TASK_SUMMARY_ATTRIBUTE] === "true";
}

export function backgroundTaskEventIdOf(ctx: AuthCarrier): string | null {
  const value = ctx.session.auth.current?.attributes[BACKGROUND_TASK_EVENT_ATTRIBUTE];
  return typeof value === "string" && value ? value : null;
}
