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

// A reminder by the clock waits for a timezone nobody named yet (#451). The zone offered on the
// button, and used to keep follow-ups out of the night, is the one most of the family has set, or
// the product zone the external groups already use; it is never stored without the person's answer.
export const PRODUCT_SUGGESTED_TIMEZONE = GROUP_REMINDER_TIMEZONE;
// «Через N минут» is an exact moment that needs no zone; a year of minutes bounds a countdown.
export const REMINDER_COUNTDOWN_MAX_MINUTES = 525_600;
export const REMINDER_TZ_FOLLOWUP_DELAY_MINUTES = 180;
// A reminder too close for the usual delay gets one quick follow-up, if even that fits before it.
export const REMINDER_TZ_FOLLOWUP_SHORT_DELAY_MINUTES = 15;
// The family group cannot hold the question, so the private chat hears it at once.
export const REMINDER_TZ_FOLLOWUP_GROUP_DELAY_MINUTES = 1;
export const REMINDER_TZ_FOLLOWUP_MARGIN_MINUTES = 10;
export const REMINDER_TZ_FOLLOWUP_MIN_GAP_MINUTES = 60;
export const REMINDER_TZ_NIGHT_START_HOUR = 22;
export const REMINDER_TZ_NIGHT_END_HOUR = 8;
export const REMINDER_TZ_MORNING_HOUR = 9;
// The latest any zone can be (UTC−12): a clock time read there has passed everywhere afterwards.
export const REMINDER_TZ_LATEST_ZONE = "Etc/GMT+12";
export const REMINDER_TZ_REPEATING_WAIT_DAYS = 7;
// Waits that ended unanswered this recently are named when the timezone finally arrives.
export const REMINDER_TZ_RECENTLY_EXPIRED_DAYS = 7;
export const REMINDER_TZ_AWAITING_LIST_LIMIT = 20;
