/**
 * Long-term memory product and embedding configuration.
 *
 * Exports:
 * - `MEMORY_SCOPE_QUOTAS`: agreed maximum record counts by scope.
 * - Retrieval and thread-creation gates, ranking calibration, pagination, E5, and chunking.
 * - Timeline-selection and retired-worker controller compatibility constants.
 * - R3 always-on profile subject, claim, character, and inactivity limits.
 * - Durable profile-projection notice delivery lease.
 * - Source-backed thread context, activation, episode, and history budgets.
 * - Durable memory-thread notice delivery lease.
 */
export const MEMORY_SCOPE_QUOTAS = {
  family: 20_000,
  group: 10_000,
  personal: 5_000,
} as const;

export const MEMORY_CONTENT_MAX_LENGTH = 4_000;
export const MEMORY_ATTRIBUTE_MAX_CHARACTERS = 64;
export const MEMORY_LIST_DEFAULT_LIMIT = 20;
export const MEMORY_LIST_MAX_LIMIT = 50;
export const MEMORY_RETRIEVAL_LIMIT = 12;
// Automatic per-turn context enters model input on every step, so it is narrower than tool search.
export const MEMORY_TURN_RETRIEVAL_LIMIT = 8;
export const MEMORY_RETRIEVAL_CANDIDATE_LIMIT = 40;

export const CONVERSATION_TIMELINE_SELECTION_MAX_ENTRIES = 50;

// The retired service remains until the installed production controller removes its process contract.
export const MEMORY_EXTRACTION_WORKER_IDLE_MILLISECONDS = 1_000;
export const MEMORY_EXTRACTION_WORKER_READY_PATH = "/tmp/osinara-memory-extraction-worker-ready";
export const MEMORY_EXTRACTION_WORKER_STABILITY_MILLISECONDS = 30_000;
export const MEMORY_EVIDENCE_SNIPPET_MAX_CHARACTERS = 1_000;

// Live briefs are generated only for activated threads and contain whole source-backed records.
// Per-turn budgets are prompt-cost budgets: the model can read a full thread through
// read_memory_thread when the automatic brief is not enough.
export const THREAD_CONTEXT_MAX_THREADS = 2;
export const THREAD_CONTEXT_MAX_CHARACTERS = 6_000;
export const THREAD_TITLE_MAX_CHARACTERS = 120;
export const THREAD_PURPOSE_MAX_CHARACTERS = 500;
export const THREAD_BRIEF_MAX_CHARACTERS = 3_000;
export const THREAD_BRIEF_MAX_ITEMS = 20;
export const THREAD_CONTEXT_EPISODES_PER_THREAD = 3;
export const THREAD_EPISODE_MAX_CHARACTERS = 2_000;
export const THREAD_HISTORY_PAGE_MAX_ENTRIES = 20;
export const THREAD_HISTORY_PAGE_MAX_CHARACTERS = 12_000;
export const THREAD_SOURCE_INPUT_MAX_CHARACTERS = 40_000;
export const THREAD_TITLE_MIN_SEMANTIC_SIMILARITY = 0.78;
// Short E5 passage embeddings have a high unrelated baseline; creation therefore uses a separate
// calibrated gate above the observed negative range instead of reusing broad retrieval recall.
export const THREAD_CREATION_TITLE_MIN_SEMANTIC_SIMILARITY = 0.92;
// Creation uses a conservative lexical gate: false positives stop a write and require clarification.
export const THREAD_PURPOSE_MIN_TRIGRAM_SIMILARITY = 0.9;
export const THREAD_CREATION_CANDIDATE_LIMIT = 3;
export const THREAD_CREATION_MAX_ATTEMPTS = 2;
export const THREAD_CREATION_ATTEMPT_LEASE_MILLISECONDS = 5 * 60 * 1_000;
export const THREAD_NOTICE_DELIVERY_LEASE_MILLISECONDS = 5 * 60 * 1_000;

// Profile context is a bounded read projection; whole claims are skipped rather than truncated.
export const PROFILE_CONTEXT_MAX_SUBJECTS = 4;
export const PROFILE_CONTEXT_MAX_CHARACTERS = 6_000;
export const PROFILE_CONTEXT_MAX_CLAIMS_PER_SUBJECT = 20;
export const PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS = 4_000;
export const PROFILE_SELECTION_DORMANCY_MILLISECONDS = 60 * 24 * 60 * 60 * 1_000;
export const PROFILE_PROJECTION_NOTICE_LEASE_MILLISECONDS = 5 * 60 * 1_000;

// Branch gates are calibrated by memory-retrieval-v1 and apply before reciprocal-rank fusion.
export const MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_RANK = 0.05;
export const MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_RANK = 0.05;
export const MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY = 0.78;
export const MEMORY_RETRIEVAL_RRF_RANK_OFFSET = 60;
export const MEMORY_RETRIEVAL_CONFIRMATION_BOOST = 0.001;
// Retention (ACT-R / Ebbinghaus in closed form): R = exp(-age / S), S = S0 * (1 + ln(1 + n)).
// S0 by record kind in days; only the automatic turn block applies the minimum retention.
export const MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE = "итог обсуждения";
export const MEMORY_STABILITY_DAYS_EPISODE = 30;
export const MEMORY_STABILITY_DAYS_DISCUSSION_SUMMARY = 60;
export const MEMORY_STABILITY_DAYS_SEMANTIC = 180;
export const MEMORY_RETENTION_RANK_FLOOR = 0.3;
export const MEMORY_AUTO_CONTEXT_MIN_RETENTION = 0.2;
export const MEMORY_SEMANTIC_KINDS = ["profile", "preference", "fact", "family_shared"] as const;
// Near-duplicate gate at write time; the prod embedder (multilingual-e5-small) keeps distinct facts
// above 0.9 too, so the model decides and the gate only surfaces candidates.
export const MEMORY_NEAR_DUPLICATE_SIMILARITY = 0.9;
export const MEMORY_NEAR_DUPLICATE_CANDIDATES = 2;

export const MEMORY_EMBEDDING_DIMENSIONS = 384;
export const MEMORY_EMBEDDING_MODEL = "intfloat/multilingual-e5-small";
export const MEMORY_EMBEDDING_MODEL_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3";
export const MEMORY_EMBEDDING_MODEL_VERSION =
  `${MEMORY_EMBEDDING_MODEL}@${MEMORY_EMBEDDING_MODEL_REVISION}`;
export const MEMORY_EMBEDDING_LEASE_MILLISECONDS = 120_000;
export const MEMORY_EMBEDDING_JOB_BATCH_SIZE = 4;
export const MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE = 8;

// Character bounds guarantee E5's 512-token limit even for adversarial punctuation-heavy text.
export const MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS = 400;
export const MEMORY_EMBEDDING_CHUNK_MIN_BOUNDARY_CHARACTERS = 280;
export const MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS = 80;

// A record shown to the model in the last N turns of the same session stays out of the automatic
// context; the model can still search for it. Production showed the same three facts 50 times a day.
export const MEMORY_EXPOSURE_WINDOW_TURNS = 10;
// The current author's own profile card returns after this many turns unless they became the subject.
export const PROFILE_AUTHOR_CARD_WINDOW_TURNS = 20;
