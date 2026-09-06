/**
 * Stable memory-review runtime configuration.
 *
 * Exports:
 * - Batch size, dispatch/alert leases, bounded recovery, stale/abandoned bounds, claim bounds.
 */
/**
 * A running batch waits only for its own turn to report back. This bound is the last resort for a
 * turn that never does, so it must stay far above any real turn, including one that survives a
 * restart. Provenance, not this clock, decides what happens to the batch when it expires.
 */
export const MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE = 10;
export const MEMORY_REVIEW_ABANDONED_TURN_TIMEOUT_MILLISECONDS = 60 * 60 * 1_000;
export const MEMORY_REVIEW_BATCH_SIZE = 50;
export const MEMORY_REVIEW_DISPATCH_BATCH_SIZE = 10;
// Idle review: a lane is reviewed once ten sources accumulate, after ten minutes of silence with
// at least five sources, or after six hours of silence with anything at all. One or two messages
// on their own gave the model nothing to judge: production reviewed 607 messages in 108 batches
// (80 of them with one or two sources) and kept nine records.
export const MEMORY_REVIEW_IDLE_MILLISECONDS = 10 * 60 * 1_000;
export const MEMORY_REVIEW_IDLE_MIN_SOURCES = 10;
export const MEMORY_REVIEW_IDLE_MIN_BATCH_SOURCES = 5;
export const MEMORY_REVIEW_LONG_IDLE_MILLISECONDS = 6 * 60 * 60 * 1_000;
// A group tail shorter than this stays for idle review instead of riding the addressed turn.
export const MEMORY_REVIEW_INTERACTIVE_MIN_SOURCES = 8;
// Existing claims shown to the review so it versions slots instead of duplicating.
export const MEMORY_REVIEW_CONTEXT_LIMIT = 40;
// Already processed messages shown before a background batch so the tail reads in context.
export const MEMORY_REVIEW_PRECEDING_CONTEXT_LIMIT = 20;
export const MEMORY_REVIEW_DISPATCH_LEASE_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_INTERACTIVE_START_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;
export const MEMORY_REVIEW_MAX_SAFE_RECOVERY_ATTEMPTS = 1;
export const MEMORY_REVIEW_OWNER_ALERT_BATCH_SIZE = 10;
export const MEMORY_REVIEW_OWNER_ALERT_LEASE_MILLISECONDS = 15 * 60 * 1_000;
