/**
 * Reminder product and dispatcher limits.
 *
 * Exports:
 * - Named content, pagination, recurrence, batch, lease, and lateness constants.
 * - External-group reminder timezone, its live reminder cap and the accepted first-run window.
 */
export const REMINDER_CONTENT_MAX_LENGTH = 1_000;
export const REMINDER_LIST_DEFAULT_LIMIT = 100;
export const REMINDER_LIST_MAX_LIMIT = 100;
export const REMINDER_RECURRENCE_INTERVAL_MAX = 365;
export const REMINDER_DISPATCH_BATCH_SIZE = 25;
export const REMINDER_DISPATCH_LEASE_MILLISECONDS = 5 * 60_000;
export const REMINDER_DISPATCH_LATE_AFTER_MILLISECONDS = 90_000;
export const REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS = 3;

// A participant of an external group has no account and therefore no personal timezone. Public
// group reminders are interpreted in one product-wide zone instead, so no chat needs configuring.
export const GROUP_REMINDER_TIMEZONE = "Europe/Moscow";
// A reminder of a public chat belongs to the chat, so the only quota is the shared one.
export const GROUP_REMINDER_MAX_PER_CHAT = 30;

// A public-chat reminder must describe a current request rather than a far-past notification.
export const GROUP_REMINDER_MAX_BACKDATE_MS = 24 * 60 * 60_000;
