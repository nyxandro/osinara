/**
 * Shared machinery of the retrieval quality evaluations.
 *
 * Exports:
 * - `retrievalEvalsEnabled`: whether the evals run here; refuses a setup where they would mislead.
 * - `EvalRecordText`: what indexing needs from a corpus record.
 * - `evalRecordId`: the stored id of a corpus record, derived from its key.
 * - `indexEvalRecords`: stores every record and its vectors the way production indexes them.
 * - `evalResultKeys`: the corpus keys of what a search returned.
 * - `evalAutomaticSelection`: the automatic selection of a turn for one prepared question.
 * - `evalShare`: a ratio rounded to three decimals — a share, or a mean per query — that refuses an
 *   empty category; `categoryRate` is that share over one category of evaluated queries.
 *
 * Each corpus owns its rows — areas, authors, statuses differ between a family and a group — so
 * the caller inserts the record and returns its id; indexing is the part that must not differ.
 */
import { createHash } from "node:crypto";

import { database } from "./database.js";
import { embedMemoryPassages } from "./memory-embedding-client.js";
import { chunkMemoryContent } from "./memory-embedding-chunks.js";
import { memoryEmbeddingInput } from "./memory-embedding-header.js";
import { MEMORY_EMBEDDING_MODEL_VERSION, MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE } from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { MemoryKind } from "./memory-record.js";
import {
  selectMemoriesAutomatically,
  type AutomaticMemorySelection,
  type SelectedMemory,
} from "./memory-automatic-selection.js";

export function retrievalEvalsEnabled(): boolean {
  const enabled = process.env.RUN_MEMORY_RETRIEVAL_EVALS === "true";
  if (!enabled) return false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
    throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для retrieval eval нужна отдельная БД *_test");
  }
  // Every eval file owns the whole database in its setup, and vitest runs files in parallel unless
  // integration mode is on: the corpora would wipe each other and the numbers be quietly wrong.
  if (process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true") {
    throw new Error(
      "AGENT_TEST_PARALLELISM_UNSAFE: Замеру поиска нужен RUN_DATABASE_INTEGRATION_TESTS=true",
    );
  }
  return true;
}

export interface EvalRecordText {
  content: string;
  key: string;
  kind: MemoryKind;
  /** What the record is about, as production would put it into the indexed text. */
  subjectLabel?: string;
}

/**
 * Records of equal relevance and equal date are ordered by id inside each search branch, and that
 * place feeds the fused score. A random id would let such a record move between runs; one derived
 * from the key keeps every run of the same corpus identical.
 */
export function evalRecordId(key: string): string {
  const hex = createHash("md5").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The real chunker runs over every record: an entry that outgrew one chunk is indexed the way
 * production would index it, not flattened into a single synthetic vector. Returns ids by key.
 */
export async function indexEvalRecords<T extends EvalRecordText>(
  records: readonly T[],
  insertRecord: (record: T) => Promise<string>,
): Promise<Map<string, string>> {
  // Results are mapped back to records by their text, so two records with one text would let one
  // stand in for the other — an offered superseded version could pass for the current one.
  const contents = new Set(records.map((record) => record.content));
  if (contents.size !== records.length) {
    throw new Error("AGENT_MEMORY_RETRIEVAL_EVAL_DUPLICATE_CONTENT: у двух записей корпуса одинаковый текст");
  }
  const flatChunks = records.flatMap((record) =>
    chunkMemoryContent(record.content).map((chunk) => ({
      chunk,
      // The same text production sends: the chunk carrying the subject it is about.
      input: memoryEmbeddingInput(chunk.content, { kind: record.kind, subjectLabel: record.subjectLabel ?? null }),
      record,
    })),
  );
  const embeddings: number[][] = [];
  for (let offset = 0; offset < flatChunks.length; offset += MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE) {
    embeddings.push(...await embedMemoryPassages(
      flatChunks.slice(offset, offset + MEMORY_EMBEDDING_PROVIDER_BATCH_SIZE).map((entry) => entry.input),
    ));
  }

  const ids = new Map<string, string>();
  for (const record of records) {
    if (ids.has(record.key)) {
      throw new Error(`AGENT_MEMORY_RETRIEVAL_EVAL_DUPLICATE_KEY: ключ ${record.key} встречается дважды`);
    }
    ids.set(record.key, await insertRecord(record));
  }
  for (const [index, entry] of flatChunks.entries()) {
    await database().query(
      `INSERT INTO memory_embedding_chunks
         (memory_item_id, chunk_index, content, embedding_input, start_offset, end_offset,
          embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
      [
        ids.get(entry.record.key),
        entry.chunk.chunkIndex,
        entry.chunk.content,
        entry.input,
        entry.chunk.startOffset,
        entry.chunk.endOffset,
        `[${embeddings[index]!.join(",")}]`,
        MEMORY_EMBEDDING_MODEL_VERSION,
      ],
    );
  }
  return ids;
}

export function evalResultKeys(
  contents: readonly string[],
  keyByContent: ReadonlyMap<string, string>,
): string[] {
  return contents.map((content) => {
    const key = keyByContent.get(content);
    if (!key) throw new Error(`AGENT_MEMORY_RETRIEVAL_EVAL_UNKNOWN_RECORD: ${JSON.stringify(content)}`);
    return key;
  });
}

export function evalShare(matching: number, total: number): number {
  if (total === 0) {
    throw new Error("AGENT_MEMORY_RETRIEVAL_EVAL_EMPTY_CATEGORY: категория выборки пуста");
  }
  // Three decimals keep a pinned baseline stable without hiding a one-query change.
  return Math.round((matching / total) * 1_000) / 1_000;
}

export function categoryRate<Category extends string, Entry extends { query: { category: Category } }>(
  entries: readonly Entry[],
  category: Category,
  passes: (entry: Entry) => boolean,
): number {
  const selected = entries.filter((entry) => entry.query.category === category);
  return evalShare(selected.filter(passes).length, selected.length);
}

/**
 * What the automatic selection of a turn offers for one prepared question, through the same
 * function the turn uses: small talk, the hybrid search and the date a question names.
 */
export async function evalAutomaticSelection(
  auth: MemoryAuthorization,
  prepared: string,
  limit: number,
): Promise<AutomaticMemorySelection & { results: SelectedMemory[] }> {
  const selection = await selectMemoriesAutomatically(auth, prepared, { limit, now: new Date(), window: null });
  return { ...selection, results: selection.selected };
}
