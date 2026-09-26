/**
 * Agent schedule product and dispatcher limits.
 *
 * Exports:
 * - Content, list, recurrence, lease, and batch constants for scheduled agent runs.
 */
export const AGENT_SCHEDULE_TITLE_MAX_LENGTH = 120;
export const AGENT_SCHEDULE_USER_REQUEST_MAX_LENGTH = 2_000;
export const AGENT_SCHEDULE_PROMPT_MAX_LENGTH = 8_000;
export const AGENT_SCHEDULE_LIST_DEFAULT_LIMIT = 100;
export const AGENT_SCHEDULE_LIST_MAX_LIMIT = 100;
export const AGENT_SCHEDULE_DISPATCH_BATCH_SIZE = 10;
export const AGENT_SCHEDULE_DISPATCH_LEASE_MILLISECONDS = 10 * 60_000;
export const AGENT_SCHEDULE_DISPATCH_MAX_SAFE_ATTEMPTS = 3;
export const AGENT_SCHEDULE_RECURRENCE_INTERVAL_MAX = 365;
export const AGENT_SCHEDULE_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
// Each wake-up is a full model call over the whole chat history and holds the chat while it runs.
export const AGENT_SCHEDULE_CONVERSATION_MAX_ACTIVE = 3;
// Caps the cost of one wake-up schedule: at most this many full model calls over the chat history.
export const AGENT_SCHEDULE_CONVERSATION_MAX_RUNS = 50;
// A conversation that waits for a person's approval answer is retried this long after it was found busy.
export const AGENT_SCHEDULE_CONVERSATION_DEFER_MILLISECONDS = 60_000;
// Eve must start a wake-up turn within this window or refuses it; the chat is idle when it is sent,
// so a turn that did not start by then never reached Eve. It also bounds recovery after a crash.
export const AGENT_SCHEDULE_CONVERSATION_ADMISSION_MILLISECONDS = 5 * 60_000;
// Slack past the admission deadline before a turn that never started is written off.
export const AGENT_SCHEDULE_CONVERSATION_ADMISSION_MARGIN_MILLISECONDS = 30_000;
// A wake-up turn whose observer gave up has had its cancellation requested; one that still has not
// reported this long after is treated as lost, so its schedule can run again.
export const AGENT_SCHEDULE_CONVERSATION_TURN_LOST_MILLISECONDS = 60 * 60_000;
