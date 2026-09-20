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
/**
 * How much of the existing memory the review is shown before its batch. The block is what stops
 * the review writing down a fact it already wrote in other words, and every record in it is paid
 * for on every batch, so it is small and recent rather than complete.
 *
 * Measured on production: a message averages 139 characters and a batch holds fifty of them, so
 * the batch itself costs roughly fourteen thousand characters with its JSON. A record averages
 * 239 characters, so fifteen of them add about four and a half thousand — near a third more per
 * batch. At the observed rate of about 237 batches a month that is a few hundred thousand extra
 * tokens, against 865 pairs of near-duplicate records the review keeps producing.
 */
export const MEMORY_REVIEW_KNOWN_RECORD_LIMIT = 15;
/** How many already-reviewed messages precede the batch, so the model sees where it begins. */
export const MEMORY_REVIEW_REVIEWED_TAIL_LIMIT = 5;
export const MEMORY_REVIEW_DISPATCH_BATCH_SIZE = 10;
export const MEMORY_REVIEW_DISPATCH_LEASE_MILLISECONDS = 60 * 1_000;
export const MEMORY_REVIEW_INTERACTIVE_START_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_MAX_SAFE_RECOVERY_ATTEMPTS = 1;
export const MEMORY_REVIEW_OWNER_ALERT_BATCH_SIZE = 10;
export const MEMORY_REVIEW_OWNER_ALERT_LEASE_MILLISECONDS = 15 * 60 * 1_000;
