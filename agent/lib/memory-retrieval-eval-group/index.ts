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
 * - The selection never stays empty when it should. `smallTalkEmptyRate` = 0 with 8.875 records
 *   per reaction on average — real memory showed 11.8 on the same kind of turn — and
 *   `participantNearMissEmptyRate` = 0: asked what Nina said about a tool she never mentioned,
 *   the search offers Nina's other records and the tool's documentation.
 * - The bot does not find itself. «Осинара, как ты выглядишь?» misses the avatar record: the
 *   bot's name is stripped from the start of the question before the search, and what is left,
 *   «как ты выглядишь», names nothing. «кто тебя сделал?» never carried the name and finds its
 *   author below third place for the same reason — «тебя» says nothing about whom. That is
 *   `botPersonaRecallAt12` = 0.75 with one persona question offered low.
 * - Other words: «железо» reaches nothing about the hosting record; «гитхаб», «гардрейлы» and
 *   «нжинкс» are found, the first at second place behind a debate about RAG.
 * - Isolation held for every question, asked by an outsider and by the family owner; the test
 *   fails on any leak, so it is not a number here.
 */
export const MEMORY_RETRIEVAL_EVAL_GROUP_BASELINE = {
  aliasWordingRecallAt12: 0.75,
  aliasWordingTopThreeRate: 0.75,
  botPersonaRecallAt12: 0.75,
  expectedInTopThreeRate: 0.875,
  linkRecallAt12: 1,
  participantNearMissEmptyRate: 0,
  participantRecallAt12: 1,
  participantTopThreeRate: 1,
  positiveRecallAt12: 0.917,
  smallTalkEmptyRate: 0,
  smallTalkMeanOffered: 8.875,
  topicFullCoverageRate: 1,
  topicRecallAt12: 1,
} as const;
