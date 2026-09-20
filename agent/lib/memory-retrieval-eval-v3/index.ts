/**
 * Versioned live-shaped fixture for long-term memory retrieval evaluation.
 *
 * Exports:
 * - `MEMORY_RETRIEVAL_EVAL_FIXTURE_VERSION_V3`: immutable fixture contract version.
 * - `MEMORY_RETRIEVAL_EVAL_RECORDS_V3`: the whole synthetic family corpus.
 * - `MEMORY_RETRIEVAL_EVAL_QUERIES_V3`: the queries measured against it.
 * - `MEMORY_RETRIEVAL_R1_BASELINE_V3`: measured current behaviour, failures included.
 * - `MEMORY_RETRIEVAL_BASELINE_V3_BEFORE_WAVE_2`: the same corpus before candidate selection changed.
 * - `MEMORY_RETRIEVAL_V3_FUTURE_GATES`: acceptance targets for the retrieval work that follows.
 *
 * Why this fixture exists: v1 and v2 hold about twenty-five records and short clean questions, and
 * every threshold in the pipeline was calibrated on them. A corpus three orders of magnitude
 * smaller than production, asked in a form the product almost never sees, cannot tell whether a
 * change helped. This one is larger, spans two memory areas, and asks in the shapes people
 * actually use.
 *
 * The baseline below is measured, not desired. Where today's pipeline fails a whole category, the
 * number says so — the same practice as v2, and the reason a later change can be proven to help.
 *
 * What this fixture deliberately does not cover, so nobody reads more into its numbers than is there:
 * - **Group memory.** The measurement runs as the owner in a private chat, where group records are
 *   not authorized at all; adding them would measure access rules, not retrieval quality, and the
 *   access rules have their own integration tests.
 * - **Subject columns.** Subjects live inside the record text; `subject_label` and `subject_user_id`
 *   are empty, so the profile projection path is untouched. The work that puts a subject header
 *   into the vector will need them and should add them together with the change it measures.
 * - **Wall-clock drift.** The fused score carries a recency term computed from `now()`, so the
 *   pinned numbers are not eternal: the corpus dates are fixed and the term keeps shrinking. The
 *   spread is around 1e-4 against a rank step of 1.6e-2, which is why the numbers hold in practice
 *   rather than by construction.
 */
import { MEMORY_RETRIEVAL_EVAL_RECORDS_EVENTS_V3 } from "./records-events.js";
import { MEMORY_RETRIEVAL_EVAL_RECORDS_HOUSEHOLD_V3 } from "./records-household.js";
import { MEMORY_RETRIEVAL_EVAL_RECORDS_PEOPLE_V3 } from "./records-people.js";
import { MEMORY_RETRIEVAL_EVAL_RECORDS_WORK_V3 } from "./records-work.js";
import type { MemoryRetrievalEvalRecordV3 } from "./types.js";

export { MEMORY_RETRIEVAL_EVAL_QUERIES_V3 } from "./queries.js";

export const MEMORY_RETRIEVAL_EVAL_FIXTURE_VERSION_V3 = "memory-retrieval-v3-live-shapes";

export const MEMORY_RETRIEVAL_EVAL_RECORDS_V3: readonly MemoryRetrievalEvalRecordV3[] = [
  ...MEMORY_RETRIEVAL_EVAL_RECORDS_PEOPLE_V3,
  ...MEMORY_RETRIEVAL_EVAL_RECORDS_HOUSEHOLD_V3,
  ...MEMORY_RETRIEVAL_EVAL_RECORDS_WORK_V3,
  ...MEMORY_RETRIEVAL_EVAL_RECORDS_EVENTS_V3,
];

/**
 * Measured on the pinned E5 model against this exact corpus, after the candidate-selection work of
 * wave 2. What the word branches do is no longer the debt here; what remains is abstention:
 *
 * - `nearMissEmptyRate` = 0. Every question whose answer is absent but whose neighbour is almost
 *   right still returns records, at similarities of 0.824 to 0.858. Asked for the code to a garage
 *   that was never mentioned, the search offers the code to the gate. No similarity threshold can
 *   fix this: those numbers sit inside the range of genuine answers. It needs a signal that says
 *   *what the record is about*, which is the subject header of #193.
 * - `negativeEmptyRate` = 0.5. Half the questions that are not about memory at all still return
 *   records, at 0.781 to 0.791 against a gate of 0.78. A gate at 0.80 makes this 1.0 — and costs
 *   memory-retrieval-v1 both of its pure paraphrases, whose nearest true answer sits at 0.79002.
 *   The two distributions touch. Measured, not argued; see #196.
 * - `semanticParaphraseRecallAt12` = 0.667 and `longQueryRecallAt12` = 0.833. The right record is
 *   scored well above the gate — 0.844, 0.797, 0.862 — and still loses its place among twelve to
 *   records that share more words with the question. On this corpus size the gate is no longer
 *   what loses a paraphrase; the composition of the twelve slots is.
 *
 * `typoRecallAt12` = 1 is the opposite kind of result: all five typos, including distorted proper
 * nouns, are recovered by the existing three branches, which is evidence against adding a fourth
 * one on trigrams (#199).
 */
export const MEMORY_RETRIEVAL_R1_BASELINE_V3 = {
  botAddressRecallAt12: 1,
  emojiMarkupRecallAt12: 1,
  exactRecallAt12: 1,
  expectedInTopThreeRate: 0.9,
  lexicalBranchFireRate: 0.86,
  liveShapeLexicalFireRate: 0.917,
  longQueryFullCoverageRate: 0.667,
  longQueryRecallAt12: 1,
  mixedLanguageRecallAt12: 1,
  multiTopicFullCoverageRate: 0.6,
  multiTopicRecallAt12: 1,
  nearMissEmptyRate: 0,
  negativeEmptyRate: 0.5,
  positiveRecallAt12: 0.96,
  russianMorphologyRecallAt12: 1,
  semanticParaphraseRecallAt12: 0.667,
  typoRecallAt12: 1,
  voiceTranscriptRecallAt12: 1,
  yoSpellingRecallAt12: 1,
} as const;

/**
 * What the same corpus measured before wave 2, kept so the effect of that work stays visible in
 * the repository rather than only in a merged pull request.
 */
export const MEMORY_RETRIEVAL_BASELINE_V3_BEFORE_WAVE_2 = {
  expectedInTopThreeRate: 0.816,
  lexicalBranchFireRate: 0.245,
  liveShapeLexicalFireRate: 0,
  longQueryFullCoverageRate: 0,
  longQueryRecallAt12: 0.6,
  multiTopicFullCoverageRate: 0.2,
  multiTopicRecallAt12: 0.8,
  positiveRecallAt12: 0.898,
} as const;

/**
 * Targets for the retrieval work that follows, not gates today. They become gates only together
 * with the change each of them measures; until then the baseline above is what the test pins.
 */
export const MEMORY_RETRIEVAL_V3_FUTURE_GATES = {
  nearMissEmptyRateMinimum: 0.6,
  negativeEmptyRateMinimum: 0.8,
  semanticParaphraseRecallAt12Minimum: 0.833,
} as const;
