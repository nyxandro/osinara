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
export const MEMORY_LIST_DEFAULT_LIMIT = 20;
export const MEMORY_LIST_MAX_LIMIT = 50;
export const MEMORY_RETRIEVAL_LIMIT = 12;
export const MEMORY_RETRIEVAL_CANDIDATE_LIMIT = 40;
export const MEMORY_INCIDENT_STATEMENT_TIMEOUT_MS = 1_000;
export const MEMORY_INCIDENT_QUERY_TIMEOUT_MS = 1_500;

export const CONVERSATION_TIMELINE_SELECTION_MAX_ENTRIES = 50;

// The retired service remains until the installed production controller removes its process contract.
export const MEMORY_EXTRACTION_WORKER_IDLE_MILLISECONDS = 1_000;
export const MEMORY_EXTRACTION_WORKER_READY_PATH = "/tmp/osinara-memory-extraction-worker-ready";
/**
 * The embedding worker touches this file on every pass of its loop, and its healthcheck requires
 * it to be fresh. Without it a hung worker was indistinguishable from a healthy one: the process
 * stays alive, memories keep being written, and they quietly stop being findable by meaning.
 */
export const MEMORY_EMBEDDING_WORKER_READY_PATH = "/tmp/osinara-memory-embedding-worker-ready";
/**
 * How stale the readiness mark may be before the container is called unhealthy. The loop polls
 * every second when idle and a batch is bounded, so half a minute is far longer than any honest
 * pass and short enough to notice within a deploy window.
 */
export const MEMORY_EMBEDDING_WORKER_STALE_MILLISECONDS = 30_000;
export const MEMORY_EXTRACTION_WORKER_STABILITY_MILLISECONDS = 30_000;
export const MEMORY_EVIDENCE_SNIPPET_MAX_CHARACTERS = 1_000;

// Live briefs are generated only for activated threads and contain whole source-backed records.
export const THREAD_CONTEXT_MAX_THREADS = 2;
export const THREAD_CONTEXT_MAX_CHARACTERS = 16_000;
export const THREAD_TITLE_MAX_CHARACTERS = 120;
export const THREAD_PURPOSE_MAX_CHARACTERS = 500;
export const THREAD_BRIEF_MAX_CHARACTERS = 6_000;
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
export const PROFILE_CONTEXT_MAX_CHARACTERS = 12_000;
export const PROFILE_CONTEXT_MAX_CLAIMS_PER_SUBJECT = 30;
export const PROFILE_CONTEXT_MAX_SUBJECT_CHARACTERS = 8_000;
export const PROFILE_SELECTION_DORMANCY_MILLISECONDS = 60 * 24 * 60 * 60 * 1_000;
export const PROFILE_PROJECTION_NOTICE_LEASE_MILLISECONDS = 5 * 60 * 1_000;

// Branch gates apply before reciprocal-rank fusion.
//
// The word branches count how many of the question's own distinctive words the record contains,
// and require two of them — or the whole question, when it was a single word like «4271».
//
// A rank cannot serve as the gate once the branches match on OR instead of AND: one matched word
// scores the same whether the question was one word long or ten, so «4271» and «Сколько стоит
// билет на поезд до Владивостока?» both land at 0.1. A share of the question does not work either,
// and the measurement says so: at half the words, a long multi-topic message stops matching
// anything, because no single record holds half of a question about three different things.
// Two words is what separates «код домофона в подъезде» from a chance hit on «курс» in a question
// about the exchange rate. Calibrated on memory-retrieval-v3; the two branches do different jobs,
// so they keep separate names even while they carry the same number today.
export const MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_TERM_MATCHES = 2;
export const MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_TERM_MATCHES = 2;
// Measured twice and left where it was. On memory-retrieval-v3 every off-topic question scores at
// most 0.791, which tempts a gate at 0.80 — and at 0.80 memory-retrieval-v1 loses both of its pure
// paraphrases, whose nearest true answer sits at 0.79002. The two distributions touch, so no single
// number both admits a paraphrase and refuses a question that is not about memory at all. That is
// the answer to #196: abstention has to come from a signal other than this similarity.
export const MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY = 0.78;
// A floating cutoff relative to that threshold was tried here and removed: on both fixtures it
// changed no measured number. It can only trim one query's own tail, and an off-topic question has
// a low best score, so its tail is measured against that same low score.
export const MEMORY_RETRIEVAL_RRF_RANK_OFFSET = 60;
export const MEMORY_RETRIEVAL_CONFIRMATION_BOOST = 0.001;
// How many turns back the automatic selection remembers what it already showed. Three is short
// enough that a record the conversation keeps needing comes back within a couple of exchanges, and
// long enough to stop the immediate repeat that measured as half of all shows. The explicit search
// is not bounded by it at all: a deliberate lookup must see everything.
export const MEMORY_RETRIEVAL_RECENT_SHOW_WINDOW_TURNS = 3;
// How much of the show journal is kept behind the window. Nothing reads further back than the
// window itself, apart from a retried turn looking for its own rows, so the rest is dead weight:
// production takes about 360 turns a day across all chats, and at twelve records a turn the
// journal would outgrow the memory it serves within months. Fifty turns is one session's worth of
// conversation — far longer than any retry lives, and a fixed ceiling per chat.
export const MEMORY_RETRIEVAL_SHOW_JOURNAL_RETAINED_TURNS = 50;
// Freshness used to be a term added to the fused score, and at 0.0005 against a rank step of
// 0.0164 it was a tie-breaker wearing the name of a ranking factor. It is now a multiplier over
// the whole score, and the curve lives in `memory-forgetting.ts`.

export const MEMORY_EMBEDDING_DIMENSIONS = 384;
export const MEMORY_EMBEDDING_MODEL = "intfloat/multilingual-e5-small";
export const MEMORY_EMBEDDING_MODEL_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3";
export const MEMORY_EMBEDDING_MODEL_VERSION =
  `${MEMORY_EMBEDDING_MODEL}@${MEMORY_EMBEDDING_MODEL_REVISION}`;
export const MEMORY_EMBEDDING_LEASE_MILLISECONDS = 120_000;
export const MEMORY_EMBEDDING_JOB_BATCH_SIZE = 4;
export const MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE = 8;

// A record that never reaches `indexed` is invisible to semantic search forever, so a failure that
// was only the service being away must not be terminal. The retry is tied to the recorded reason,
// not to a timer: these two codes are the cases where the text was never rejected — the service was
// unreachable, or it answered that it was overloaded. Everything else stays terminal, including a
// plain rejected request, which may be input the model refuses and would spin forever, and an
// expired lease, whose ending is simply unknown. Both return to the queue by operator reindex.
export const MEMORY_EMBEDDING_TRANSIENT_ERROR_CODES = [
  "AGENT_MEMORY_EMBEDDING_PROVIDER_BUSY",
  "AGENT_MEMORY_EMBEDDING_PROVIDER_UNAVAILABLE",
] as const;
// One original attempt plus two retries. The delay is a guard, not the trigger: without it the
// idle-polling worker would burn both retries in the same second the service went down.
export const MEMORY_EMBEDDING_MAX_ATTEMPTS = 3;
export const MEMORY_EMBEDDING_RETRY_DELAY_MILLISECONDS = 5 * 60 * 1_000;

// E5's own window. The service runs with truncation off, so a passage past this comes back as an
// error and the record never enters the semantic index at all.
export const MEMORY_EMBEDDING_MAX_TOKENS = 512;
// Chosen from a measurement of this model's tokenizer rather than from the worst case it could
// meet. On the evaluation corpus ordinary Russian runs 2.7 characters per token, its first
// percentile is 2.0, text with links and codes 2.4; nine hundred characters is therefore about
// 450 tokens for text of that shape, inside the window with the passage prefix and some room.
// The shapes that fall outside — a line of single letters at 1.5, a script with a token per
// character — are caught by the token check before sending and cut again, so the limit no longer
// has to be the worst case for every record to be safe. The previous 400 spent a third of the
// window on every ordinary record to buy that safety.
export const MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS = 900;
export const MEMORY_EMBEDDING_CHUNK_MIN_BOUNDARY_CHARACTERS = 630;
export const MEMORY_EMBEDDING_CHUNK_OVERLAP_CHARACTERS = 180;
