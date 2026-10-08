/**
 * Versioned group-chat fixture for long-term memory retrieval evaluation.
 *
 * Exports:
 * - `MEMORY_RETRIEVAL_EVAL_GROUP_FIXTURE_VERSION`: immutable fixture contract version.
 * - `MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS`: the measured chat and the bait around it.
 * - `MEMORY_RETRIEVAL_EVAL_GROUP_QUERIES`: the questions asked in the measured chat.
 * - `MEMORY_RETRIEVAL_EVAL_GROUP_BASELINE`: measured current behaviour, failures included.
 *
 * Why this fixture exists: v3 measures a private chat, and on real memory 127 of 153 golden-set
 * turns came from an external group, where 96% of the memory lives. A group turn searches its own
 * group only; the questions there are about people, shared tools, links, and the bot itself, and
 * most messages ask nothing at all. This corpus asks those questions as a participant of one
 * external group, with bait in every other area of the same family.
 *
 * Isolation is asserted, not measured: a record from another area in a group's selection is a
 * leak, and the test fails on it whatever the quality numbers say.
 */
import { MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS_AGENTS_CHAT } from "./records-agents-chat.js";
import { MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS_OTHER_AREAS } from "./records-other-areas.js";
import type { MemoryRetrievalEvalGroupRecord } from "./types.js";

export { MEMORY_RETRIEVAL_EVAL_GROUP_QUERIES } from "./queries.js";

export const MEMORY_RETRIEVAL_EVAL_GROUP_FIXTURE_VERSION = "memory-retrieval-group-v1";

export const MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS: readonly MemoryRetrievalEvalGroupRecord[] = [
  ...MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS_AGENTS_CHAT,
  ...MEMORY_RETRIEVAL_EVAL_GROUP_RECORDS_OTHER_AREAS,
];

/**
 * Measured 07.10.2026 on the pinned E5 model against this exact corpus.
 *
 * - Questions about one person work: `participantRecallAt12` and `participantTopThreeRate` = 1.
 *   The subject header carried into the indexed text («Вика Лунина (vlunina). Вид: …») puts the
 *   person's own records first even when neighbours share the topic.
 * - Small talk stays empty half the time. «ахаха», «умница», «+1» and «ну всё, я спать» are made
 *   of small-talk words only and are not searched at all (#341, 08.10.2026); «ты подшофе?», «а мем
 *   так-то смешной» and the other two use ordinary words and still get records — that is
 *   `smallTalkEmptyRate` = 0.5 from 0, and records per reaction fell from 8.875. Before the
 *   change real memory showed 11.8 records on the same kind of turn.
 * - `participantNearMissEmptyRate` = 0: asked what Nina said about a tool she never mentioned, the
 *   search offers Nina's other records and the tool's documentation.
 * - The bot finds itself, from 08.10.2026 (#346). «Осинара, как ты выглядишь?» used to miss the
 *   avatar record: the name is cut from the start of the question, and «как ты выглядишь» named
 *   nothing. In a group the name now goes back in where «ты» can only mean the bot, and
 *   `botPersonaRecallAt12` rose from 0.75 to 1, every persona question with its answer first.
 * - Other words: «железо» and «гардрейлы» are asked of the bot, so its name brings the hosting and
 *   guardrails records to the top too — `aliasWordingRecallAt12` and its top-three rate rose from
 *   0.75 to 1. «гитхаб» is asked with «свой», which names nobody, and is still found second.
 * - The price is one reaction: «ты подшофе?» is about the bot as well and now gets its records,
 *   4.75 records per small-talk line instead of 4.375.
 * - Isolation held for every question, asked by an outsider and by the family owner; the test
 *   fails on any leak, so it is not a number here.
 */
export const MEMORY_RETRIEVAL_EVAL_GROUP_BASELINE = {
  aliasWordingRecallAt12: 1,
  aliasWordingTopThreeRate: 1,
  botPersonaRecallAt12: 1,
  expectedInTopThreeRate: 1,
  linkRecallAt12: 1,
  participantNearMissEmptyRate: 0,
  participantRecallAt12: 1,
  participantTopThreeRate: 1,
  positiveRecallAt12: 1,
  smallTalkEmptyRate: 0.5,
  smallTalkMeanOffered: 4.75,
  topicFullCoverageRate: 1,
  topicRecallAt12: 1,
} as const;
