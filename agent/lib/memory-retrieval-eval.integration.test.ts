/**
 * Versioned synthetic PostgreSQL/E5 retrieval quality evaluation.
 *
 * Constructs covered:
 * - R1 gates compare positive recall, irrelevant-query abstention, and duplicate pollution.
 * - V2 reports production-derived identity hard negatives without pre-implementing semantic gating.
 * - Russian morphology, exact tokens, mixed-language text, semantic paraphrases, and one typo are exercised.
 * - The pinned multilingual E5 model embeds the synthetic corpus and every eval query.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { embedMemoryPassages, embedMemoryQuery } from "./memory-embedding-client.js";
import {
  MEMORY_EMBEDDING_MODEL_VERSION,
  MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE,
  MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_RANK,
  MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY,
  MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_RANK,
} from "./memory-config.js";
import {
  MEMORY_RETRIEVAL_R0_BASELINE_V1,
  MEMORY_RETRIEVAL_EVAL_QUERIES_V1,
  MEMORY_RETRIEVAL_EVAL_RECORDS_V1,
  MEMORY_RETRIEVAL_R1_GATES_V1,
  MEMORY_RETRIEVAL_R1_SEMANTIC_CALIBRATION_V1,
  type MemoryRetrievalEvalQuery,
} from "./memory-retrieval-eval-fixture.v1.js";
import {
  MEMORY_RETRIEVAL_EVAL_QUERIES_V2,
  MEMORY_RETRIEVAL_EVAL_RECORDS_V2,
  MEMORY_RETRIEVAL_R1_BASELINE_V2,
} from "./memory-retrieval-eval-fixture.v2.js";
import { memoryRetrievalRepository } from "./memory-retrieval-repository.js";
import type { MemoryAuthorization } from "./memory-context.js";

const enabled = process.env.RUN_MEMORY_RETRIEVAL_EVALS === "true";
const databaseUrl = process.env.DATABASE_URL;
if (enabled && (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для retrieval eval нужна отдельная БД *_test");
}
const describeEval = enabled ? describe : describe.skip;
const EVAL_RESULT_LIMIT = 5;
const EVAL_RECORDS = [
  ...MEMORY_RETRIEVAL_EVAL_RECORDS_V1,
  ...MEMORY_RETRIEVAL_EVAL_RECORDS_V2,
] as const;

interface EvaluatedQuery {
  duplicateCount: number;
  hit: boolean;
  query: MemoryRetrievalEvalQuery;
  resultAttributions: Array<{ branches: string[]; key: string }>;
  resultKeys: string[];
}

function requireFixtureKey(contentToKey: ReadonlyMap<string, string>, content: string): string {
  const key = contentToKey.get(content);
  if (!key) {
    throw new Error(`AGENT_MEMORY_RETRIEVAL_EVAL_UNKNOWN_RECORD: ${JSON.stringify(content)}`);
  }
  return key;
}

describeEval("memory retrieval eval v1", () => {
  let auth: MemoryAuthorization;
  const contentToKey = new Map(
    EVAL_RECORDS.map((record) => [record.content, record.key]),
  );

  beforeAll(async () => {
    // The fixture owns the disposable database for deterministic ranks and metrics.
    await database().query(
      "TRUNCATE memory_embedding_chunks, memory_embedding_jobs, memory_items_all, family_memberships, users, families CASCADE",
    );
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Синтетический retrieval eval') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('retrieval-eval-v1', 'Eval') RETURNING id",
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
      telegramActorId: "retrieval-eval-v1",
      telegramActorKind: "telegram_user",
      telegramUserId: "retrieval-eval-v1",
      userId: user.rows[0]!.id,
    };

    // Batch within the provider contract while retaining the real pinned multilingual E5 vectors.
    const embeddings: number[][] = [];
    for (
      let offset = 0;
      offset < EVAL_RECORDS.length;
      offset += MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE
    ) {
      embeddings.push(...await embedMemoryPassages(
        EVAL_RECORDS
          .slice(offset, offset + MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE)
          .map((record) => record.content),
      ));
    }

    // Each synthetic row receives one source-aligned chunk, which isolates retrieval quality from chunking.
    for (const [index, record] of EVAL_RECORDS.entries()) {
      const inserted = await database().query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
            content, source, confirmation, sensitivity, operation_key, embedding_status, updated_at)
         VALUES ($1, $2, $2, $3, 'personal', 'fact', $4, 'eval:retrieval-v1',
                 'user_confirmed', 'normal', $5, 'indexed', $6)
         RETURNING id`,
        [auth.familyId, auth.userId, auth.telegramUserId, record.content, record.key, record.updatedAt],
      );
      await database().query(
        `INSERT INTO memory_embedding_chunks
           (memory_item_id, chunk_index, content, start_offset, end_offset, embedding, embedding_model)
         VALUES ($1, 0, $2, 0, $3, $4::vector, $5)`,
        [
          inserted.rows[0]!.id,
          record.content,
          record.content.length,
          `[${embeddings[index]!.join(",")}]`,
          MEMORY_EMBEDDING_MODEL_VERSION,
        ],
      );
    }
  });

  afterAll(async () => closeDatabase());

  it("meets the versioned R1 quality gates and prints the measured result", async () => {
    const evaluated: EvaluatedQuery[] = [];
    for (const query of MEMORY_RETRIEVAL_EVAL_QUERIES_V1) {
      const { results } = await memoryRetrievalRepository.search(
        auth,
        query.text,
        await embedMemoryQuery(query.text),
        EVAL_RESULT_LIMIT,
      );
      // Every exposed attribution must carry branch-local evidence that already passed its gate.
      for (const result of results) {
        if (result.evidence.simpleLexicalRank !== null) {
          expect(result.evidence.simpleLexicalRank)
            .toBeGreaterThanOrEqual(MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_RANK);
        }
        if (result.evidence.russianMorphologyRank !== null) {
          expect(result.evidence.russianMorphologyRank)
            .toBeGreaterThanOrEqual(MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_RANK);
        }
        if (result.evidence.semanticSimilarity !== null) {
          expect(result.evidence.semanticSimilarity)
            .toBeGreaterThanOrEqual(MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY);
        }
      }
      const resultKeys = results.map((result) =>
        requireFixtureKey(contentToKey, result.memory.content)
      );
      evaluated.push({
        duplicateCount: query.key === "duplicate-pollution"
          ? resultKeys.filter((key) => key.startsWith("duplicate-")).length
          : 0,
        hit: query.expectedKeys.length === 0
          ? results.length === 0
          : query.expectedKeys.some((key) => resultKeys.includes(key)),
        query,
        resultAttributions: results.map((result, index) => ({
          branches: [
            result.evidence.simpleLexicalRank === null ? null : "simple",
            result.evidence.russianMorphologyRank === null ? null : "russian",
            result.evidence.semanticSimilarity === null ? null : "semantic",
          ].filter((branch): branch is string => branch !== null),
          key: resultKeys[index]!,
        })),
        resultKeys,
      });
    }

    // Typo quality is measured separately: pg_trgm is justified only if E5 plus FTS cannot recover it.
    const positive = evaluated.filter((entry) =>
      entry.query.category !== "negative" && entry.query.category !== "typo"
    );
    const negative = evaluated.filter((entry) => entry.query.category === "negative");
    const metrics = {
      duplicateResultsAt5: evaluated.find((entry) => entry.query.key === "duplicate-pollution")!
        .duplicateCount,
      negativeEmptyRate: negative.filter((entry) => entry.hit).length / negative.length,
      positiveRecallAt5: positive.filter((entry) => entry.hit).length / positive.length,
      typoRecovered: evaluated.find((entry) => entry.query.category === "typo")!.hit,
    };
    console.info("MEMORY_RETRIEVAL_EVAL_V1", JSON.stringify({ evaluated, metrics }));

    expect(MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY).toBeGreaterThan(
      MEMORY_RETRIEVAL_R1_SEMANTIC_CALIBRATION_V1.irrelevantSimilarityMaximum,
    );
    expect(MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY).toBeLessThan(
      MEMORY_RETRIEVAL_R1_SEMANTIC_CALIBRATION_V1.requiredParaphraseSimilarityMinimum,
    );
    // The checked-in baseline makes an accidental return to R0's always-return behavior measurable.
    expect(metrics.negativeEmptyRate).toBeGreaterThan(MEMORY_RETRIEVAL_R0_BASELINE_V1.negativeEmptyRate);
    expect(metrics.duplicateResultsAt5).toBeLessThan(
      MEMORY_RETRIEVAL_R0_BASELINE_V1.duplicateResultsAt5,
    );
    expect(metrics.positiveRecallAt5).toBeGreaterThanOrEqual(
      MEMORY_RETRIEVAL_R1_GATES_V1.positiveRecallAt5Minimum,
    );
    expect(metrics.negativeEmptyRate).toBeGreaterThanOrEqual(
      MEMORY_RETRIEVAL_R1_GATES_V1.negativeEmptyRateMinimum,
    );
    expect(metrics.duplicateResultsAt5).toBeLessThanOrEqual(
      MEMORY_RETRIEVAL_R1_GATES_V1.duplicateResultsAt5Maximum,
    );
    expect(evaluated
      .find((entry) => entry.query.key === "inflected-name")
      ?.resultAttributions.find((result) => result.key === "architect-meeting")?.branches)
      .toContain("russian");
    expect(evaluated
      .find((entry) => entry.query.key === "exact-number")
      ?.resultAttributions.find((result) => result.key === "storage-code")?.branches)
      .toContain("simple");
    expect(evaluated
      .find((entry) => entry.query.key === "cross-language-paraphrase")
      ?.resultAttributions.find((result) => result.key === "backup-location")?.branches)
      .toContain("semantic");
    expect(metrics.typoRecovered).toBe(true);
  }, 120_000);

  it("measures identity hard-negative abstention while preserving exact controls", async () => {
    const evaluated: EvaluatedQuery[] = [];
    for (const query of MEMORY_RETRIEVAL_EVAL_QUERIES_V2) {
      const { results } = await memoryRetrievalRepository.search(
        auth,
        query.text,
        await embedMemoryQuery(query.text),
        EVAL_RESULT_LIMIT,
      );
      const resultKeys = results.map((result) =>
        requireFixtureKey(contentToKey, result.memory.content)
      );
      evaluated.push({
        duplicateCount: 0,
        hit: query.expectedKeys.length === 0
          ? results.length === 0
          : query.expectedKeys.some((key) => resultKeys.includes(key)),
        query,
        resultAttributions: results.map((result, index) => ({
          branches: [
            result.evidence.simpleLexicalRank === null ? null : "simple",
            result.evidence.russianMorphologyRank === null ? null : "russian",
            result.evidence.semanticSimilarity === null ? null : "semantic",
          ].filter((branch): branch is string => branch !== null),
          key: resultKeys[index]!,
        })),
        resultKeys,
      });
    }

    // V2 records the known quality gap without silently changing the separately scoped search policy.
    const controls = evaluated.filter((entry) => entry.query.category !== "negative");
    const hardNegatives = evaluated.filter((entry) => entry.query.category === "negative");
    const metrics = {
      hardNegativeEmptyRate: hardNegatives.filter((entry) => entry.hit).length /
        hardNegatives.length,
      hardNegativeQueries: hardNegatives.length,
      identityControlRecallAt5: controls.filter((entry) => entry.hit).length / controls.length,
    };
    console.info("MEMORY_RETRIEVAL_EVAL_V2_IDENTITY", JSON.stringify({ evaluated, metrics }));

    expect(metrics).toEqual(MEMORY_RETRIEVAL_R1_BASELINE_V2);
  }, 120_000);
});
