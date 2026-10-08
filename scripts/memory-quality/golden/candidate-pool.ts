/**
 * The candidates one real question could have been answered from, in a disposable database copy.
 *
 * Exports:
 * - `POOL_CANDIDATES_PER_BRANCH`: how many candidates each ungated branch adds to the pool.
 * - `requireReviewedSearchStatement`: refuses a product statement GATES were not checked against.
 * - `ungatedSearchParameters`: the product statement's parameters with its gates opened.
 * - `requireDisposableCopy`: refuses any database that is not a fresh, complete evaluation copy.
 * - `requireResumableCopy`: accepts only the evaluation copy a run already started on.
 * - `rewindCopyTo`: puts memory back to how it stood when a question was asked.
 * - `loadShowJournal`: what the model was shown and named as used, per turn, before any change.
 * - `recordDetails`: a record's text and attributes by ref, deleted or not.
 * - `collectTurnCandidates`: offered and pooled records of one question with their text, and the
 *   refs that passed the gates, which only explain why a relevant pooled record was missed.
 * - `collectGatedCandidates`: every record that passed a branch gate for one question, with each
 *   branch's score, so another fusion of the same branches can be ranked without a new copy.
 *
 * Every number comes from the product's own code: the automatic selection a turn makes, and the
 * search statement it runs, bound once with the product's parameters and once with the gates opened.
 *
 * A question is judged against memory as it stood when it was asked. A record written from that
 * very message would otherwise be found by its own words and inflate every number, so the copy is
 * walked from the newest question back and rewound to each one as it goes. The rewind edits the
 * copy for good, which is why the copy is spent by one run and a marker table refuses a second: a
 * fresh copy has to be restored first.
 *
 * What it does not reproduce: the automatic selection's suppression of records shown in the last
 * three turns, the profile view and thread briefs beside the records, usage counts as they were
 * then, a record's age — the forgetting curve counts it to the moment of the run, so a question
 * asked days before is ranked with every record those days older — and two changes that leave no
 * trace: a duplicate mark, and the supersession a deleted record had made (deletion releases it).
 */
import { createHash } from "node:crypto";

import { AppError } from "../../../agent/lib/app-error.js";
import { database } from "../../../agent/lib/database.js";
import {
  MEMORY_RETRIEVAL_CANDIDATE_LIMIT,
  MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_TERM_MATCHES,
  MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY,
  MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_TERM_MATCHES,
} from "../../../agent/lib/memory-config.js";
import type { MemoryAuthorization } from "../../../agent/lib/memory-context.js";
import {
  memoryRetrievalSearchParameters,
  memoryRetrievalSearchStatement,
} from "../../../agent/lib/memory-retrieval-repository.js";
import { selectMemoriesAutomatically } from "../../../agent/lib/memory-automatic-selection.js";
import type { GoldenTurn } from "./golden-score.js";
import type { GoldenQuery } from "./turn-queries.js";

/**
 * Ten a branch, gates opened: beyond the twelve offered this adds what each branch would have
 * brought next and what its gate cut, while keeping a pool one judge can read through honestly.
 * Twenty made 8121 pairs over 153 turns, most of them the gated set nobody offered.
 */
export const POOL_CANDIDATES_PER_BRANCH = 10;

const RUN_MARKER_TABLE = "memory_golden_eval_run";

/**
 * The statement GATES were last checked against, and its parameter count. A gate added to it — a
 * new parameter or a threshold written into the text — would stay closed in the "ungated" pool
 * and quietly narrow it, so any edit stops the run until GATES are checked again.
 */
// Reviewed 08.10.2026: the seventeenth parameter is the branch agreement factor, a multiplier on
// the fused rank that cuts nothing, and the repeat filter reads only the selection's own shows
// (#339) — neither is a gate, so GATES stay complete.
const REVIEWED_STATEMENT_SHA256 = "0194f54b41172bb07dc9bc28a0f76dfdfd636496b7b78724ecdaa17cec06660d";
const REVIEWED_PARAMETER_COUNT = 17;

/** Where the gates sit in the product's parameter list, with the value each must hold there. */
const GATES = [
  { index: 5, product: MEMORY_RETRIEVAL_CANDIDATE_LIMIT, ungated: POOL_CANDIDATES_PER_BRANCH },
  { index: 6, product: MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_TERM_MATCHES, ungated: 1 },
  { index: 7, product: MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_TERM_MATCHES, ungated: 1 },
  // Cosine similarity cannot fall below -1, so nothing the nearest-chunk lookup returns is cut.
  { index: 10, product: MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY, ungated: -1 },
] as const;

export function requireReviewedSearchStatement(statement: string): void {
  const digest = createHash("sha256").update(statement).digest("hex");
  if (digest === REVIEWED_STATEMENT_SHA256) return;
  throw new AppError(
    "AGENT_MEMORY_GOLDEN_STATEMENT_CHANGED",
    "Запрос поиска памяти изменился после последней сверки пула. Проверьте, какие пороги он применяет, обновите GATES и REVIEWED_STATEMENT_SHA256 в candidate-pool.ts",
    { details: { digest } },
  );
}

export function ungatedSearchParameters(product: readonly unknown[]): unknown[] {
  const drifted = GATES.filter((gate) => product[gate.index] !== gate.product);
  if (product.length !== REVIEWED_PARAMETER_COUNT || drifted.length > 0) {
    throw new AppError(
      "AGENT_MEMORY_GOLDEN_PARAMETERS_CHANGED",
      `Параметры поиска памяти изменились: их ${product.length} вместо ${REVIEWED_PARAMETER_COUNT}, расхождения на позициях ${drifted.map((gate) => gate.index).join(", ") || "—"}. Обновите GATES в candidate-pool.ts по memoryRetrievalSearchParameters`,
    );
  }
  const ungated = [...product];
  for (const gate of GATES) ungated[gate.index] = gate.ungated;
  return ungated;
}

/**
 * The run edits records for good, so it must never touch anything but a copy made for it — and
 * the copy must search the way production does, or the numbers describe another system. Every
 * check runs before the marker, so a refused copy is not spent.
 */
export async function requireDisposableCopy(repositoryMigrations: readonly string[]): Promise<void> {
  const name = (await database().query<{ name: string }>("SELECT current_database() AS name")).rows[0]!.name;
  if (!name.endsWith("_eval")) {
    throw new AppError(
      "AGENT_MEMORY_GOLDEN_DATABASE_UNSAFE",
      `База ${name} не похожа на копию для замера: имя должно кончаться на _eval. Замер меняет записи и запускается только на восстановленной копии`,
    );
  }
  const spent = (await database().query<{ spent: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS spent", [RUN_MARKER_TABLE],
  )).rows[0]!.spent;
  if (spent) {
    throw new AppError(
      "AGENT_MEMORY_GOLDEN_COPY_SPENT",
      "Эта копия уже использована прошлым прогоном: записи в ней изменены. Восстановите копию заново",
    );
  }
  // Migration 107 sets the vector scan on the database by its name, and a restore under another
  // name does not carry it: the semantic branch then gets one portion of nearest chunks, most of
  // them other areas' or hidden, and thins out. Without statistics the planner guesses instead.
  const tuning = (await database().query<{ analyzed: number; iterative: boolean }>(
    `SELECT EXISTS (
              SELECT 1 FROM pg_db_role_setting AS setting
              JOIN pg_database AS db ON db.oid = setting.setdatabase
              WHERE db.datname = current_database() AND setting.setrole = 0
                AND 'hnsw.iterative_scan=relaxed_order' = ANY(setting.setconfig)
            ) AS iterative,
            (SELECT count(*)::int FROM pg_stat_user_tables
             WHERE relname IN ('memory_items_all', 'memory_embedding_chunks')
               AND coalesce(last_analyze, last_autoanalyze) IS NOT NULL) AS analyzed`,
  )).rows[0]!;
  if (!tuning.iterative || tuning.analyzed < 2) {
    throw new AppError(
      "AGENT_MEMORY_GOLDEN_COPY_UNTUNED",
      "Копия не настроена после восстановления: нет итеративного обхода векторного индекса или статистики таблиц памяти. Выполните шаги настройки из шапки compose.memory-golden-eval.yaml",
      { details: { analyzedTables: tuning.analyzed, iterativeScan: String(tuning.iterative) } },
    );
  }
  // The statement is the repository's; on an older schema it fails or reads columns differently.
  // Migrations the repository has since deleted may stay in the ledger: they are history.
  const applied = new Set((await database().query<{ name: string }>("SELECT name FROM schema_migrations")).rows
    .map((row) => row.name));
  const missing = repositoryMigrations.filter((migration) => !applied.has(migration));
  if (missing.length > 0) {
    throw new AppError(
      "AGENT_MEMORY_GOLDEN_COPY_SCHEMA_BEHIND",
      `В копии не применены миграции репозитория (${missing.length}, первая — ${missing[0]}). Примените их командой из шапки compose.memory-golden-eval.yaml`,
      { details: { missing: missing.join(", ") } },
    );
  }
  await database().query(`CREATE TABLE ${RUN_MARKER_TABLE} (started_at timestamptz NOT NULL DEFAULT now())`);
  await database().query(`INSERT INTO ${RUN_MARKER_TABLE} DEFAULT VALUES`);
}

/**
 * A run that stopped half-way continues on the copy it spent: walked from the newest question
 * back, the copy already stands at the last turn finished, and every remaining turn is older.
 */
export async function requireResumableCopy(): Promise<void> {
  const state = (await database().query<{ name: string; started: boolean }>(
    "SELECT current_database() AS name, to_regclass($1) IS NOT NULL AS started", [RUN_MARKER_TABLE],
  )).rows[0]!;
  if (!state.name.endsWith("_eval") || !state.started) {
    throw new AppError(
      "AGENT_MEMORY_GOLDEN_COPY_NOT_RESUMABLE",
      `База ${state.name} не копия, на которой начат этот прогон. Продолжать можно только на ней; иначе удалите незаконченный файл и начните на свежей копии`,
    );
  }
}

/**
 * A record's status at the moment, for one that is retracted now: deletion and a choice between
 * versions both overwrite it, but the replacement it underwent stays in `claim_relations`, and a
 * choice made before the moment had already retracted it then.
 */
const SUCCESSOR_AT_MOMENT = (alias: string) => `(
  SELECT relation.target_claim_id
  FROM claim_relations AS relation
  JOIN memory_items_all AS successor ON successor.id = relation.target_claim_id
  WHERE relation.source_claim_id = ${alias}.id
    AND relation.relation_type IN ('temporal_update', 'correction')
    AND successor.created_at < $1
  ORDER BY successor.created_at DESC
  LIMIT 1
)`;
const LOST_CHOICE_BEFORE_MOMENT = (alias: string) => `EXISTS (
  SELECT 1 FROM claim_conflicts AS earlier
  WHERE earlier.resolution = 'chosen' AND earlier.resolved_at < $1
    AND ${alias}.id IN (earlier.claim_a_id, earlier.claim_b_id) AND earlier.chosen_claim_id <> ${alias}.id
)`;
const RETURN_TO_STATUS_AT_MOMENT = (candidates: string) => `
  WITH returning_records AS (
    SELECT DISTINCT candidate.id, ${SUCCESSOR_AT_MOMENT("candidate")} AS successor_id
    FROM (${candidates}) AS candidate
    WHERE NOT ${LOST_CHOICE_BEFORE_MOMENT("candidate")}
  )
  UPDATE memory_items_all AS item
  SET deleted_at = NULL,
      claim_status = (CASE WHEN returning_records.successor_id IS NULL THEN 'active' ELSE 'superseded' END)
                     ::memory_claim_status,
      superseded_by = returning_records.successor_id
  FROM returning_records
  WHERE item.id = returning_records.id`;

/**
 * Puts memory back to how it stood at `moment`, as far as the copy keeps the history. Called with
 * ever older moments: what one call hides was younger than every later moment too, and what it
 * restores stays until its own creation hides it.
 */
export async function rewindCopyTo(moment: string): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    // Did not exist yet.
    await client.query(
      "UPDATE memory_items_all SET deleted_at = now() WHERE deleted_at IS NULL AND created_at >= $1",
      [moment],
    );
    // Deleted later: was still there, in the status it had then. A record this rewind hid was
    // created at or after the moment and never matches.
    await client.query(RETURN_TO_STATUS_AT_MOMENT(
      `SELECT id FROM memory_items_all
       WHERE deleted_at >= $1 AND created_at < $1 AND claim_status = 'retracted'`,
    ), [moment]);
    // Its successor did not exist yet, so it was still the current version.
    await client.query(
      `UPDATE memory_items_all AS previous SET claim_status = 'active', superseded_by = NULL
       FROM memory_items_all AS successor
       WHERE successor.id = previous.superseded_by AND previous.claim_status = 'superseded'
         AND successor.created_at >= $1`,
      [moment],
    );
    // A choice made later had not retracted the other version yet. Before the conflicts detected
    // later are dropped: a conflict both detected and decided later still retracted that version.
    await client.query(RETURN_TO_STATUS_AT_MOMENT(
      `SELECT version.id
       FROM claim_conflicts AS conflict
       JOIN memory_items_all AS version ON version.id IN (conflict.claim_a_id, conflict.claim_b_id)
       WHERE conflict.resolution = 'chosen' AND conflict.resolved_at >= $1
         AND version.id <> conflict.chosen_claim_id AND version.claim_status = 'retracted'
         AND version.deleted_at IS NULL`,
    ), [moment]);
    await client.query("DELETE FROM claim_conflicts WHERE detected_at >= $1", [moment]);
    await client.query(
      `UPDATE claim_conflicts
       SET resolution = 'unresolved', chosen_claim_id = NULL, resolved_at = NULL,
           resolved_by_user_id = NULL, resolved_by_telegram_user_id = NULL, resolution_metadata = NULL
       WHERE resolved_at >= $1`,
      [moment],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * What the turn's automatic selection showed, and which of it that same turn used. Since #339 the
 * journal also holds what the model's own search, listing or the standing profile showed, and a
 * show may be spent by a later turn of the session; neither is the selection's offer to this turn.
 */
export async function loadShowJournal(): Promise<Map<string, { shown: string[]; used: string[] }>> {
  const rows = await database().query<{ agent_session_id: string; memory_ref: string; turn_id: string; used: boolean }>(
    `SELECT show.agent_session_id, show.turn_id, ref.memory_ref,
            show.used_turn_id IS NOT DISTINCT FROM show.turn_id AS used
     FROM memory_retrieval_shows AS show
     JOIN memory_item_refs AS ref ON ref.memory_item_id = show.claim_id
     WHERE show.source = 'selection'
     ORDER BY show.agent_session_id, show.turn_id, ref.memory_ref`,
  );
  const journal = new Map<string, { shown: string[]; used: string[] }>();
  for (const row of rows.rows) {
    const key = `${row.agent_session_id}\u0000${row.turn_id}`;
    const turn = journal.get(key) ?? { shown: [], used: [] };
    turn.shown.push(row.memory_ref);
    if (row.used) turn.used.push(row.memory_ref);
    journal.set(key, turn);
  }
  return journal;
}

interface CandidateRow {
  id: string | null;
  memory_ref: string;
  russian_morphology_rank: number | null;
  semantic_similarity: number | null;
  simple_lexical_rank: number | null;
}

export interface PoolRecord {
  attribute: string | null;
  /** Which branches reached the record with their gates opened; empty when only another set did. */
  branches: string[];
  content: string;
  createdAt: string;
  kind: string;
  memoryRef: string;
  occurredOn: string | null;
  scope: string;
  semanticSimilarity: number | null;
  subjectLabel: string | null;
}

async function candidateRows(parameters: readonly unknown[]): Promise<CandidateRow[]> {
  const result = await database().query<CandidateRow>(memoryRetrievalSearchStatement(), [...parameters]);
  return result.rows.filter((row) => row.id !== null);
}

/** Record text straight from the table: a shown record may have been retired since. */
export async function recordDetails(memoryRefs: readonly string[]): Promise<Map<string, Omit<PoolRecord, "branches" | "semanticSimilarity">>> {
  const rows = await database().query<{
    attribute: string | null; content: string; created_at: Date; kind: string; memory_ref: string;
    occurred_on: string | null; scope: string; subject_label: string | null;
  }>(
    `SELECT ref.memory_ref, item.content, item.kind, item.scope, item.subject_label, item.attribute,
            item.occurred_on::text AS occurred_on, item.created_at
     FROM memory_item_refs AS ref JOIN memory_items_all AS item ON item.id = ref.memory_item_id
     WHERE ref.memory_ref = ANY($1::text[])`,
    [[...memoryRefs]],
  );
  return new Map(rows.rows.map((row) => [row.memory_ref, {
    attribute: row.attribute, content: row.content, createdAt: row.created_at.toISOString(), kind: row.kind,
    memoryRef: row.memory_ref, occurredOn: row.occurred_on, scope: row.scope, subjectLabel: row.subject_label,
  }]));
}

export async function collectTurnCandidates(
  question: GoldenQuery,
  embeddings: readonly (readonly number[])[],
  production: { shown: string[]; used: string[] } | null,
): Promise<GoldenTurn & { authorization: MemoryAuthorization; pool: PoolRecord[]; startedAt: string }> {
  // What the automatic selection offered, through the turn's own function, on the day it was asked.
  const selection = await selectMemoriesAutomatically(question.authorization, question.query, {
    now: new Date(question.startedAt), window: null,
  });
  // A record in two open conflicts comes back once per group: one record, offered at its first place.
  const offered = [...new Set([
    ...selection.selected.map((selected) => selected.memory.memoryRef),
    ...selection.conflicts.flatMap((conflict) => conflict.versions.map((version) => version.memoryRef)),
  ])];
  const product = memoryRetrievalSearchParameters(question.authorization, question.query, embeddings);
  const gated = (await candidateRows(product)).map((row) => row.memory_ref);
  const ungated = await candidateRows(ungatedSearchParameters(product));

  const reached = new Map(ungated.map((row) => [row.memory_ref, row]));
  // The gated set is not judged as a whole: it only says, for a relevant record in the pool that
  // was not offered, whether a gate cut it or the twelve places went to others.
  const refs = [...new Set([...offered, ...reached.keys(), ...production?.shown ?? []])];
  const details = await recordDetails(refs);
  const pool = refs.map((memoryRef): PoolRecord => {
    const record = details.get(memoryRef);
    if (record === undefined) {
      throw new AppError(
        "AGENT_MEMORY_GOLDEN_RECORD_MISSING",
        `Запись ${memoryRef} из выдачи хода ${question.turnId} не найдена в копии базы. Копия повреждена: восстановите её заново`,
      );
    }
    const row = reached.get(memoryRef);
    return {
      ...record,
      branches: row === undefined ? [] : [
        ...(row.simple_lexical_rank === null ? [] : ["simple"]),
        ...(row.russian_morphology_rank === null ? [] : ["russian"]),
        ...(row.semantic_similarity === null ? [] : ["semantic"]),
      ],
      semanticSimilarity: row?.semantic_similarity ?? null,
    };
  });
  return {
    authorization: question.authorization,
    gated,
    message: question.message,
    offered: offered.map((memoryRef, index) => ({ memoryRef, position: index + 1 })),
    pool,
    production,
    query: question.query,
    startedAt: question.startedAt,
    turnId: question.turnId,
  };
}

/** One record that passed a gate, with what each branch said about it and how the product ranked it. */
export interface GatedCandidate {
  attribute: string | null;
  confirmation: string;
  content: string;
  createdAt: string;
  fusedScore: number;
  id: string;
  kind: string;
  memoryRef: string;
  occurredOn: string | null;
  russianRank: number | null;
  scope: string;
  semanticSimilarity: number | null;
  simpleRank: number | null;
  subjectLabel: string | null;
  updatedAt: string;
}

/** The search's own branch counts, before and after each gate, as the log line carries them. */
export interface GatedDiagnostics {
  russianMatched: number;
  russianQualified: number;
  semanticMatched: number;
  semanticQualified: number;
  semanticTopSimilarity: number | null;
  simpleMatched: number;
  simpleQualified: number;
}

interface GatedRow {
  attribute: string | null;
  confirmation: string;
  content: string;
  created_at: Date;
  fused_score: number | string;
  id: string | null;
  kind: string;
  memory_ref: string;
  occurred_on: string | Date | null;
  russian_matched: number | string;
  russian_morphology_rank: number | string | null;
  russian_qualified: number | string;
  scope: string;
  semantic_matched: number | string;
  semantic_qualified: number | string;
  semantic_top_similarity: number | string | null;
  simple_matched: number | string;
  simple_qualified: number | string;
  semantic_similarity: number | string | null;
  simple_lexical_rank: number | string | null;
  subject_label: string | null;
  updated_at: Date;
}

const optionalNumber = (value: number | string | null) => value === null ? null : Number(value);

/**
 * The product statement with the product's own gates, unlimited: everything the twelve places
 * were chosen from. A branch's order is recoverable from its score with `updatedAt` and `id` as
 * the statement's tie-breakers, so any fusion of the same three branches can be replayed offline.
 */
export async function collectGatedCandidates(
  question: GoldenQuery,
  embeddings: readonly (readonly number[])[],
): Promise<{
  candidates: GatedCandidate[]; diagnostics: GatedDiagnostics; group: boolean; message: string; query: string;
  turnId: string;
}> {
  const result = await database().query<GatedRow>(
    memoryRetrievalSearchStatement(),
    memoryRetrievalSearchParameters(question.authorization, question.query, embeddings),
  );
  // The statement always returns its diagnostics row, with or without candidates.
  const head = result.rows[0]!;
  return {
    candidates: result.rows.filter((row) => row.id !== null).map((row): GatedCandidate => ({
      attribute: row.attribute,
      confirmation: row.confirmation,
      content: row.content,
      createdAt: row.created_at.toISOString(),
      fusedScore: Number(row.fused_score),
      id: row.id!,
      kind: row.kind,
      memoryRef: row.memory_ref,
      occurredOn: row.occurred_on === null ? null : String(row.occurred_on instanceof Date
        ? row.occurred_on.toISOString().slice(0, 10) : row.occurred_on),
      russianRank: optionalNumber(row.russian_morphology_rank),
      scope: row.scope,
      semanticSimilarity: optionalNumber(row.semantic_similarity),
      simpleRank: optionalNumber(row.simple_lexical_rank),
      subjectLabel: row.subject_label,
      updatedAt: row.updated_at.toISOString(),
    })),
    diagnostics: {
      russianMatched: Number(head.russian_matched),
      russianQualified: Number(head.russian_qualified),
      semanticMatched: Number(head.semantic_matched),
      semanticQualified: Number(head.semantic_qualified),
      semanticTopSimilarity: optionalNumber(head.semantic_top_similarity),
      simpleMatched: Number(head.simple_matched),
      simpleQualified: Number(head.simple_qualified),
    },
    group: question.authorization.groupId !== null,
    message: question.message,
    query: question.query,
    turnId: question.turnId,
  };
}
