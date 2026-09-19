/**
 * Stable memory-review runtime configuration.
 *
 * Exports:
 * - Batch size and its age fallback, dispatch/alert leases, bounded recovery, stale/abandoned
 *   bounds, claim bounds.
 */
/**
 * A running batch waits only for its own turn to report back. This bound is the last resort for a
 * turn that never does, so it must stay far above any real turn, including one that survives a
 * restart. Provenance, not this clock, decides what happens to the batch when it expires.
 */
export const MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE = 10;
export const MEMORY_REVIEW_ABANDONED_TURN_TIMEOUT_MILLISECONDS = 60 * 60 * 1_000;
/**
 * A quiet group never reaches the message threshold, so the backlog would wait indefinitely.
 * The dispatcher also releases a short batch once its oldest source has waited this long,
 * which bounds how stale group memory can get at the cost of a smaller review.
 */
export const MEMORY_REVIEW_BATCH_MAX_AGE_MILLISECONDS = 12 * 60 * 60 * 1_000;
export const MEMORY_REVIEW_BATCH_SIZE = 50;
export const MEMORY_REVIEW_DISPATCH_BATCH_SIZE = 10;
export const MEMORY_REVIEW_DISPATCH_LEASE_MILLISECONDS = 60 * 1_000;
export const MEMORY_REVIEW_INTERACTIVE_START_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_MAX_SAFE_RECOVERY_ATTEMPTS = 1;
export const MEMORY_REVIEW_OWNER_ALERT_BATCH_SIZE = 10;
export const MEMORY_REVIEW_OWNER_ALERT_LEASE_MILLISECONDS = 15 * 60 * 1_000;
