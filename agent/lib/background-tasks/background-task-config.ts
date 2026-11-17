/**
 * Fixed limits of background tasks (#519, docs/plans/[16.11.2026]-background-tasks.md).
 *
 * The owner set the concurrency, the hour, the steps and the day of waiting for an answer on 16.11.2026;
 * the rest follow from them and are explained where they are used.
 */

/** Tasks running at once across the whole bot: one machine carries them all. */
export const BACKGROUND_TASK_CONCURRENCY = 3;
/** Working time of one task; queueing, waiting for an answer and a restart are not counted. */
export const BACKGROUND_TASK_ACTIVE_LIMIT_MS = 60 * 60 * 1_000;
/** Model steps of one task across all its turns. */
export const BACKGROUND_TASK_STEP_LIMIT = 100;
/** How long a task waits for a person's answer before it ends with what it has. */
export const BACKGROUND_TASK_ANSWER_WAIT_MS = 24 * 60 * 60 * 1_000;
/** No step for this long reads as "seems stuck" in the status; an ordinary step takes up to two minutes. */
export const BACKGROUND_TASK_STUCK_MS = 10 * 60 * 1_000;
/** The short turn without tools that writes what a stopped or cut-off task managed to do. */
export const BACKGROUND_TASK_SUMMARY_TIMEOUT_MS = 60 * 1_000;
/** A failed answer to a task's outcome or question is repeated this often, this many times. */
export const BACKGROUND_TASK_EVENT_RETRY_MS = 5 * 60 * 1_000;
export const BACKGROUND_TASK_EVENT_ATTEMPTS = 12;
/** An event being answered is someone else's for this long; an abandoned one is taken again after it. */
export const BACKGROUND_TASK_EVENT_LEASE_MS = 15 * 60 * 1_000;
/** Task records, their messages and events are erased this long after the task was created. */
export const BACKGROUND_TASK_RETENTION_DAYS = 30;
/** Tasks of one chat that the status lists without a number: the last day's. */
export const BACKGROUND_TASK_STATUS_WINDOW_MS = 24 * 60 * 60 * 1_000;

export const BACKGROUND_TASK_TITLE_MAX_LENGTH = 80;
export const BACKGROUND_TASK_TEXT_MAX_LENGTH = 12_000;
export const BACKGROUND_TASK_MESSAGE_MAX_LENGTH = 4_000;
export const BACKGROUND_TASK_QUESTION_MAX_LENGTH = 1_000;
export const BACKGROUND_TASK_NOTE_MAX_LENGTH = 200;
