/**
 * Live-shaped retrieval quality evaluation over the v3 corpus.
 *
 * Constructs covered:
 * - 253 synthetic records across two memory areas, embedded with the pinned multilingual E5 model.
 * - Recall measured per query shape, so a change that helps one shape and hurts another is visible.
 * - How often the lexical branches contribute to the answer, which is the claim behind #192.
 * - Whether a multi-topic or long message surfaces every one of its topics or only the loudest.
 * - Whether the right record is offered near the top, not merely present somewhere in the twelve.
 * - Abstention on a question whose answer is absent but whose neighbour is almost right.
 * - The shapes the real-memory golden set found failing — small talk, other words for the same
 *   thing, a day or a period, a fact that changed — each measured by name.
 * - A superseded version is never offered, whatever the question.
 * - The measured baseline is pinned exactly, failures included, the same practice as v2.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { chunkMemoryContent, chunkMemoryQuery } from "../memory-embedding-chunks.js";
import { MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS, MEMORY_RETRIEVAL_LIMIT } from "../memory-config.js";
import {
  categoryRate,
  evalAutomaticSelection,
  evalRecordId,
  evalResultKeys,
  evalShare as share,
  indexEvalRecords,
  retrievalEvalsEnabled,
} from "../memory-retrieval-eval-support.js";
import { prepareMemoryQuery } from "../memory-query-preparation.js";
import type { MemoryAuthorization } from "../memory-context.js";
import {
  MEMORY_RETRIEVAL_BASELINE_V3_BEFORE_WAVE_2,
  MEMORY_RETRIEVAL_EVAL_FIXTURE_VERSION_V3,
  MEMORY_RETRIEVAL_EVAL_QUERIES_V3,
  MEMORY_RETRIEVAL_EVAL_RECORDS_V3,
  MEMORY_RETRIEVAL_R1_BASELINE_V3,
} from "./index.js";
import type {
  MemoryRetrievalEvalCategoryV3,
  MemoryRetrievalEvalQueryV3,
  MemoryRetrievalEvalRecordV3,
} from "./types.js";

const describeEval = retrievalEvalsEnabled() ? describe : describe.skip;

// Production offers up to twelve records, so quality is measured at the same depth.
const EVAL_RESULT_LIMIT = MEMORY_RETRIEVAL_LIMIT;
// Rank position that counts as "the answer was actually offered", not merely present somewhere in
// the twelve. Recall alone cannot see a change that pushes the right record from first to twelfth.
const EVAL_TOP_POSITIONS = 3;
const EVAL_SETUP_TIMEOUT_MILLISECONDS = 300_000;
const EVAL_MEASUREMENT_TIMEOUT_MILLISECONDS = 120_000;

/**
 * Shapes added from the golden set. They stay out of the aggregate numbers, which are pinned and
 * compared against the wave-2 measurement over the shapes they were defined on.
 */
const GOLDEN_SET_CATEGORIES: readonly MemoryRetrievalEvalCategoryV3[] = [
  "alias_wording",
  "date_question",
  "small_talk",
  "updated_fact",
];
const DAY_MILLISECONDS = 86_400_000;

function occurredOnDate(record: MemoryRetrievalEvalRecordV3): string | null {
  if (record.occurredOn === undefined) return null;
  if (typeof record.occurredOn === "string") return record.occurredOn;
  return new Date(Date.now() - record.occurredOn.daysAgo * DAY_MILLISECONDS).toISOString().slice(0, 10);
}

/** The five shapes a live message actually takes, as opposed to a clean short question. */
const LIVE_SHAPE_CATEGORIES: readonly MemoryRetrievalEvalCategoryV3[] = [
  "bot_address",
  "emoji_markup",
  "long_query",
  "multi_topic",
  "voice_transcript",
];

interface EvaluatedQueryV3 {
  branchesInAnswer: string[];
  candidateLimitHit: boolean;
  foundExpectedKeys: string[];
  hit: boolean;
  matched: { russian: number; semantic: number; simple: number };
  qualified: { russian: number; semantic: number; simple: number };
  query: MemoryRetrievalEvalQueryV3;
  resultKeys: string[];
  topPositionHit: boolean;
  topRanks: { russian: number | null; simple: number | null };
  topSimilarity: number | null;
}

function recallOf(evaluated: readonly EvaluatedQueryV3[], category: MemoryRetrievalEvalCategoryV3): number {
  return categoryRate(evaluated, category, (entry) => entry.hit);
}

/** Share of queries of one category whose answer was among the first three, not merely present. */
function topThreeOf(evaluated: readonly EvaluatedQueryV3[], category: MemoryRetrievalEvalCategoryV3): number {
  return categoryRate(evaluated, category, (entry) => entry.topPositionHit);
}

/** Share of queries of one category that surfaced every record they asked about, not just one. */
function fullCoverageOf(evaluated: readonly EvaluatedQueryV3[], category: MemoryRetrievalEvalCategoryV3): number {
  return categoryRate(evaluated, category,
    (entry) => entry.foundExpectedKeys.length === entry.query.expectedKeys.length);
}

describeEval("memory retrieval eval v3", () => {
  let auth: MemoryAuthorization;
  const contentToKey = new Map(
    MEMORY_RETRIEVAL_EVAL_RECORDS_V3.map((record) => [record.content, record.key]),
  );

  beforeAll(async () => {
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, family_memberships, users, families CASCADE",
    );
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Синтетическая семья v3') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('retrieval-eval-v3', 'Олег') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    auth = {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramActorId: "retrieval-eval-v3",
      telegramActorKind: "telegram_user",
      telegramUserId: "retrieval-eval-v3",
      userId: user.rows[0]!.id,
    };

    const ids = await indexEvalRecords(MEMORY_RETRIEVAL_EVAL_RECORDS_V3, async (record) => {
      // A family-scope claim belongs to the family, not to a person: the schema requires
      // owner_user_id to be empty there, and the read predicate keys off membership instead.
      const inserted = await database().query<{ id: string }>(
        `INSERT INTO memory_items
           (id, family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
            content, source, confirmation, sensitivity, operation_key, embedding_status, updated_at,
            occurred_on)
         VALUES ($11, $1, $2, $3, $4, $5, $6, $7, 'eval:retrieval-v3',
                 'user_confirmed', 'normal', $8, 'indexed', $9, $10)
         RETURNING id`,
        [
          auth.familyId,
          record.scope === "personal" ? auth.userId : null,
          auth.userId,
          auth.telegramUserId,
          record.scope,
          record.kind,
          record.content,
          record.key,
          record.updatedAt,
          occurredOnDate(record),
          evalRecordId(record.key),
        ],
      );
      return inserted.rows[0]!.id;
    });
    // A replaced version stays in memory as superseded, the way a correction leaves it.
    for (const record of MEMORY_RETRIEVAL_EVAL_RECORDS_V3) {
      if (record.supersededBy === undefined) continue;
      const successor = ids.get(record.supersededBy);
      if (successor === undefined) {
        throw new Error(`AGENT_MEMORY_RETRIEVAL_EVAL_UNKNOWN_SUCCESSOR: ${record.key} → ${record.supersededBy}`);
      }
      await database().query(
        "UPDATE memory_items_all SET claim_status = 'superseded', superseded_by = $2 WHERE id = $1",
        [ids.get(record.key), successor],
      );
    }
  }, EVAL_SETUP_TIMEOUT_MILLISECONDS);

  afterAll(async () => closeDatabase());

  it("keeps the long fixtures longer than one chunk, whatever the chunk limit becomes", () => {
    // This is the check that was missing. The long queries were written against a 400-character
    // chunk limit; when it rose to 900 they quietly became single-chunk, and the category went on
    // reporting numbers under a name it no longer earned. Length is not the invariant — the number
    // of chunks is, so this fails the moment the constant moves past the fixtures again.
    const longQueries = MEMORY_RETRIEVAL_EVAL_QUERIES_V3
      .filter((query) => query.category === "long_query")
      .map((query) => ({ chunks: chunkMemoryQuery(query.text).length, key: query.key }));
    const longRecords = MEMORY_RETRIEVAL_EVAL_RECORDS_V3
      .filter((record) => record.content.length > MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS)
      .map((record) => ({ chunks: chunkMemoryContent(record.content).length, key: record.key }));

    expect(longQueries.filter((one) => one.chunks < 2)).toEqual([]);
    expect(longQueries).toHaveLength(6);
    expect(longRecords.filter((one) => one.chunks < 2)).toEqual([]);
    expect(longRecords).toHaveLength(3);
  });

  it("measures recall per live query shape and pins the result", async () => {
    const evaluated: EvaluatedQueryV3[] = [];
    for (const query of MEMORY_RETRIEVAL_EVAL_QUERIES_V3) {
      // The same text the product searches by: preparation runs before retrieval in production,
      // so a measurement that skipped it would grade a pipeline nobody runs.
      const prepared = prepareMemoryQuery(query.text);
      const { diagnostics, results } = await evalAutomaticSelection(auth, prepared, EVAL_RESULT_LIMIT);
      const resultKeys = evalResultKeys(results.map((result) => result.memory.content), contentToKey);
      evaluated.push({
        // Branch evidence of the records that actually came back, not of everything a branch
        // pulled from the corpus: a branch whose forty candidates all lost the fusion did not
        // contribute to this answer, and counting it as fired would overstate the lexical share.
        branchesInAnswer: [
          results.some((result) => result.evidence.simpleLexicalRank !== null) ? "simple" : null,
          results.some((result) => result.evidence.russianMorphologyRank !== null)
            ? "russian"
            : null,
          results.some((result) => result.evidence.semanticSimilarity !== null) ? "semantic" : null,
        ].filter((branch): branch is string => branch !== null),
        candidateLimitHit: diagnostics.candidateLimitHit,
        foundExpectedKeys: query.expectedKeys.filter((key) => resultKeys.includes(key)),
        hit: query.expectedKeys.length === 0
          ? results.length === 0
          : query.expectedKeys.some((key) => resultKeys.includes(key)),
        matched: {
          russian: diagnostics.russianMatched,
          semantic: diagnostics.semanticMatched,
          simple: diagnostics.simpleMatched,
        },
        qualified: {
          russian: diagnostics.russianQualified,
          semantic: diagnostics.semanticQualified,
          simple: diagnostics.simpleQualified,
        },
        query,
        resultKeys,
        topPositionHit: query.expectedKeys.some((key) =>
          resultKeys.slice(0, EVAL_TOP_POSITIONS).includes(key)
        ),
        topRanks: { russian: diagnostics.russianTopRank, simple: diagnostics.simpleTopRank },
        topSimilarity: diagnostics.semanticTopSimilarity,
      });
    }

    // Typos are scored on their own, like in v1: a fourth trigram branch is justified only if the
    // existing three cannot recover them, and folding that question into the overall number would
    // hide the answer. Negatives are excluded because for them a hit means an empty result.
    const positive = evaluated.filter((entry) =>
      entry.query.category !== "near_miss_negative" &&
      entry.query.category !== "negative" &&
      entry.query.category !== "typo" &&
      !GOLDEN_SET_CATEGORIES.includes(entry.query.category)
    );
    const liveShape = positive.filter((entry) =>
      LIVE_SHAPE_CATEGORIES.includes(entry.query.category)
    );
    const negative = evaluated.filter((entry) => entry.query.category === "negative");
    const nearMiss = evaluated.filter((entry) => entry.query.category === "near_miss_negative");
    const lexicalFired = (entry: EvaluatedQueryV3): boolean =>
      entry.branchesInAnswer.includes("simple") || entry.branchesInAnswer.includes("russian");
    const metrics = {
      aliasWordingRecallAt12: recallOf(evaluated, "alias_wording"),
      // The meaning branch finds slang on a clean corpus; whether it is offered first is the question.
      aliasWordingTopThreeRate: topThreeOf(evaluated, "alias_wording"),
      botAddressRecallAt12: recallOf(evaluated, "bot_address"),
      // The record of that day says what happened, not when; the date is the event's own field.
      dateQuestionRecallAt12: recallOf(evaluated, "date_question"),
      emojiMarkupRecallAt12: recallOf(evaluated, "emoji_markup"),
      exactRecallAt12: recallOf(evaluated, "exact"),
      // Recall alone cannot see a change that keeps the answer but buries it, so this is the share
      // of queries whose answer was in the first three of the twelve.
      expectedInTopThreeRate: share(
        positive.filter((entry) => entry.topPositionHit).length,
        positive.length,
      ),
      lexicalBranchFireRate: share(positive.filter(lexicalFired).length, positive.length),
      // The claim behind #192, narrowed to the shapes it is about: on a live-shaped message the
      // word branches stop contributing to the answer even when the word is in the record.
      liveShapeLexicalFireRate: share(liveShape.filter(lexicalFired).length, liveShape.length),
      longQueryFullCoverageRate: fullCoverageOf(evaluated, "long_query"),
      longQueryRecallAt12: recallOf(evaluated, "long_query"),
      mixedLanguageRecallAt12: recallOf(evaluated, "mixed_language"),
      // Whether every topic of a multi-topic message is surfaced, not just the loudest one: #194.
      multiTopicFullCoverageRate: fullCoverageOf(evaluated, "multi_topic"),
      multiTopicRecallAt12: recallOf(evaluated, "multi_topic"),
      // A question whose answer is absent but whose neighbour is almost right: the case where a
      // confident wrong answer is worse than silence.
      nearMissEmptyRate: share(nearMiss.filter((entry) => entry.hit).length, nearMiss.length),
      negativeEmptyRate: share(negative.filter((entry) => entry.hit).length, negative.length),
      positiveRecallAt12: share(positive.filter((entry) => entry.hit).length, positive.length),
      russianMorphologyRecallAt12: recallOf(evaluated, "russian_morphology"),
      semanticParaphraseRecallAt12: recallOf(evaluated, "semantic_paraphrase"),
      // A greeting or a reaction, the most common real turn: for it a hit means an empty result.
      smallTalkEmptyRate: recallOf(evaluated, "small_talk"),
      typoRecallAt12: recallOf(evaluated, "typo"),
      updatedFactRecallAt12: recallOf(evaluated, "updated_fact"),
      voiceTranscriptRecallAt12: recallOf(evaluated, "voice_transcript"),
      yoSpellingRecallAt12: recallOf(evaluated, "yo_spelling"),
    };
    console.info("MEMORY_RETRIEVAL_EVAL_V3", JSON.stringify({
      evaluated,
      metrics,
      version: MEMORY_RETRIEVAL_EVAL_FIXTURE_VERSION_V3,
    }));

    expect(MEMORY_RETRIEVAL_EVAL_RECORDS_V3.length).toBeGreaterThanOrEqual(200);
    // Not a quality number: an old version offered as current is a wrong answer, never a trade-off.
    const superseded = new Set(MEMORY_RETRIEVAL_EVAL_RECORDS_V3
      .filter((record) => record.supersededBy !== undefined).map((record) => record.key));
    expect(evaluated.flatMap((entry) => entry.resultKeys.filter((key) => superseded.has(key)))).toEqual([]);
    expect(metrics).toEqual(MEMORY_RETRIEVAL_R1_BASELINE_V3);
    // Candidate selection was changed to lift exactly these numbers. A later change that quietly
    // gives the gain back has to fail here rather than be noticed months later in a chat.
    for (const [name, before] of Object.entries(MEMORY_RETRIEVAL_BASELINE_V3_BEFORE_WAVE_2)) {
      expect({ name, improved: metrics[name as keyof typeof metrics] >= before })
        .toEqual({ name, improved: true });
    }
  }, EVAL_MEASUREMENT_TIMEOUT_MILLISECONDS);
});
