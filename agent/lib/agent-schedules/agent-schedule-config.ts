/**
 * Agent schedule product and dispatcher limits.
 *
 * Exports:
 * - Content, list, recurrence, lease, and batch constants for scheduled agent runs.
 */
export const AGENT_SCHEDULE_TITLE_MAX_LENGTH = 120;
export const AGENT_SCHEDULE_USER_REQUEST_MAX_LENGTH = 2_000;
export const AGENT_SCHEDULE_PROMPT_MAX_LENGTH = 8_000;
export const AGENT_SCHEDULE_LIST_LIMIT = 100;
export const AGENT_SCHEDULE_DISPATCH_BATCH_SIZE = 10;
export const AGENT_SCHEDULE_DISPATCH_LEASE_MILLISECONDS = 10 * 60_000;
export const AGENT_SCHEDULE_DISPATCH_MAX_SAFE_ATTEMPTS = 3;
export const AGENT_SCHEDULE_RECURRENCE_INTERVAL_MAX = 365;
export const AGENT_SCHEDULE_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
