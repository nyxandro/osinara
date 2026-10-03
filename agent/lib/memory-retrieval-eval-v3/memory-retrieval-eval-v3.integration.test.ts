/**
 * Live-shaped retrieval quality evaluation over the v3 corpus.
 *
 * Constructs covered:
 * - 243 synthetic records across two memory areas, embedded with the pinned multilingual E5 model.
 * - Recall measured per query shape, so a change that helps one shape and hurts another is visible.
 * - How often the lexical branches contribute to the answer, which is the claim behind #192.
 * - Whether a multi-topic or long message surfaces every one of its topics or only the loudest.
 * - Whether the right record is offered near the top, not merely present somewhere in the twelve.
 * - Abstention on a question whose answer is absent but whose neighbour is almost right.
 * - The measured baseline is pinned exactly, failures included, the same practice as v2.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { embedMemoryPassages, embedMemoryQueryChunks } from "../memory-embedding-client.js";
import { chunkMemoryContent, chunkMemoryQuery } from "../memory-embedding-chunks.js";
import {
  MEMORY_EMBEDDING_CHUNK_MAX_CHARACTERS,
  MEMORY_EMBEDDING_MODEL_VERSION,
  MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE,
  MEMORY_RETRIEVAL_LIMIT,
} from "../memory-config.js";
import { memoryRetrievalRepository } from "../memory-retrieval-repository.js";
import { memoryEmbeddingInput } from "../memory-embedding-header.js";
import { prepareMemoryQuery } from "../memory-query-preparation.js";
import type { MemoryAuthorization } from "../memory-context.js";
import {
  MEMORY_RETRIEVAL_BASELINE_V3_BEFORE_WAVE_2,
  MEMORY_RETRIEVAL_EVAL_FIXTURE_VERSION_V3,
  MEMORY_RETRIEVAL_EVAL_QUERIES_V3,
  MEMORY_RETRIEVAL_EVAL_RECORDS_V3,
  MEMORY_RETRIEVAL_R1_BASELINE_V3,
} from "./index.js";
import type { MemoryRetrievalEvalCategoryV3, MemoryRetrievalEvalQueryV3 } from "./types.js";

const enabled = process.env.RUN_MEMORY_RETRIEVAL_EVALS === "true";
const databaseUrl = process.env.DATABASE_URL;
if (enabled && (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для retrieval eval нужна отдельная БД *_test");
}
// Both eval files own the whole database in their setup, and vitest runs files in parallel unless
// integration mode is on. Without this guard the two corpora wipe each other and the numbers below
// would be quietly wrong instead of loudly broken.
if (enabled && process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true") {
  throw new Error(
    "AGENT_TEST_PARALLELISM_UNSAFE: Замеру поиска нужен RUN_DATABASE_INTEGRATION_TESTS=true",
  );
}
const describeEval = enabled ? describe : describe.skip;

// Production always fills every one of the twelve slots, so quality is measured at the same depth.
const EVAL_RESULT_LIMIT = MEMORY_RETRIEVAL_LIMIT;
// Rank position that counts as "the answer was actually offered", not merely present somewhere in
// the twelve. Recall alone cannot see a change that pushes the right record from first to twelfth.
const EVAL_TOP_POSITIONS = 3;
const EVAL_SETUP_TIMEOUT_MILLISECONDS = 300_000;
const EVAL_MEASUREMENT_TIMEOUT_MILLISECONDS = 120_000;

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

function share(matching: number, total: number): number {
  if (total === 0) {
    throw new Error("AGENT_MEMORY_RETRIEVAL_EVAL_EMPTY_CATEGORY: категория выборки пуста");
  }
  // Three decimals keep the pinned baseline stable without hiding a one-query change.
  return Math.round((matching / total) * 1_000) / 1_000;
}

function recallOf(
  evaluated: readonly EvaluatedQueryV3[],
  category: MemoryRetrievalEvalCategoryV3,
): number {
  const selected = evaluated.filter((entry) => entry.query.category === category);
  return share(selected.filter((entry) => entry.hit).length, selected.length);
}

/** Share of queries of one category that surfaced every record they asked about, not just one. */
function fullCoverageOf(
  evaluated: readonly EvaluatedQueryV3[],
  category: MemoryRetrievalEvalCategoryV3,
): number {
  const selected = evaluated.filter((entry) => entry.query.category === category);
  return share(
    selected.filter((entry) =>
      entry.foundExpectedKeys.length === entry.query.expectedKeys.length
    ).length,
    selected.length,
  );
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

    // The real chunker runs over every record: a corpus entry that outgrew one chunk must be
    // indexed the way production would index it, not flattened into a single synthetic vector.
    const chunked = MEMORY_RETRIEVAL_EVAL_RECORDS_V3.map((record) => ({
      chunks: chunkMemoryContent(record.content),
      record,
    }));
    const flatChunks = chunked.flatMap(({ chunks, record }) =>
      chunks.map((chunk) => ({ chunk, record })),
    );
    const embeddings: number[][] = [];
    for (let offset = 0; offset < flatChunks.length; offset += MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE) {
      embeddings.push(...await embedMemoryPassages(
        flatChunks
          .slice(offset, offset + MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE)
          // The same text production sends: the chunk carrying the subject it is about.
          .map((entry) => memoryEmbeddingInput(entry.chunk.content, {
            kind: entry.record.kind,
            subjectLabel: entry.record.subjectLabel ?? null,
          })),
      ));
    }

    const insertedIds = new Map<string, string>();
    for (const { record } of chunked) {
      // A family-scope claim belongs to the family, not to a person: the schema requires
      // owner_user_id to be empty there, and the read predicate keys off membership instead.
      const inserted = await database().query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
            content, source, confirmation, sensitivity, operation_key, embedding_status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'eval:retrieval-v3',
                 'user_confirmed', 'normal', $8, 'indexed', $9)
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
        ],
      );
      insertedIds.set(record.key, inserted.rows[0]!.id);
    }
    for (const [index, entry] of flatChunks.entries()) {
      await database().query(
        `INSERT INTO memory_embedding_chunks
           (memory_item_id, chunk_index, content, embedding_input, start_offset, end_offset,
            embedding, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
        [
          insertedIds.get(entry.record.key),
          entry.chunk.chunkIndex,
          entry.chunk.content,
          memoryEmbeddingInput(entry.chunk.content, {
            kind: entry.record.kind,
            subjectLabel: entry.record.subjectLabel ?? null,
          }),
          entry.chunk.startOffset,
          entry.chunk.endOffset,
          `[${embeddings[index]!.join(",")}]`,
          MEMORY_EMBEDDING_MODEL_VERSION,
        ],
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
      const { diagnostics, results } = await memoryRetrievalRepository.search(
        auth,
        prepared,
        await embedMemoryQueryChunks(prepared),
        EVAL_RESULT_LIMIT,
      );
      const resultKeys = results.map((result) => {
        const key = contentToKey.get(result.memory.content);
        if (!key) {
          throw new Error(
            `AGENT_MEMORY_RETRIEVAL_EVAL_UNKNOWN_RECORD: ${JSON.stringify(result.memory.content)}`,
          );
        }
        return key;
      });
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
      entry.query.category !== "typo"
    );
    const liveShape = positive.filter((entry) =>
      LIVE_SHAPE_CATEGORIES.includes(entry.query.category)
    );
    const negative = evaluated.filter((entry) => entry.query.category === "negative");
    const nearMiss = evaluated.filter((entry) => entry.query.category === "near_miss_negative");
    const lexicalFired = (entry: EvaluatedQueryV3): boolean =>
      entry.branchesInAnswer.includes("simple") || entry.branchesInAnswer.includes("russian");
    const metrics = {
      botAddressRecallAt12: recallOf(evaluated, "bot_address"),
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
      typoRecallAt12: recallOf(evaluated, "typo"),
      voiceTranscriptRecallAt12: recallOf(evaluated, "voice_transcript"),
      yoSpellingRecallAt12: recallOf(evaluated, "yo_spelling"),
    };
    console.info("MEMORY_RETRIEVAL_EVAL_V3", JSON.stringify({
      evaluated,
      metrics,
      version: MEMORY_RETRIEVAL_EVAL_FIXTURE_VERSION_V3,
    }));

    expect(MEMORY_RETRIEVAL_EVAL_RECORDS_V3.length).toBeGreaterThanOrEqual(200);
    expect(metrics).toEqual(MEMORY_RETRIEVAL_R1_BASELINE_V3);
    // Candidate selection was changed to lift exactly these numbers. A later change that quietly
    // gives the gain back has to fail here rather than be noticed months later in a chat.
    for (const [name, before] of Object.entries(MEMORY_RETRIEVAL_BASELINE_V3_BEFORE_WAVE_2)) {
      expect({ name, improved: metrics[name as keyof typeof metrics] >= before })
        .toEqual({ name, improved: true });
    }
  }, EVAL_MEASUREMENT_TIMEOUT_MILLISECONDS);
});
