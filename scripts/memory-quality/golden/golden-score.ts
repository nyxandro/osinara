/**
 * Retrieval quality on real turns, scored against relevance labels.
 *
 * Exports:
 * - `GoldenTurn`: one turn's question with what the selection offered, what passed the branch
 *   gates, the candidate pool that was labelled, and what the model then reported using.
 * - `GoldenLabels`: one turn's relevance judgement for every record of its pool.
 * - `scoreGoldenSet`: the numbers the labels support.
 *
 * Recall here is recall within the pool: a relevant record no branch put into the pool is
 * invisible to this score, the standard limit of pooled judgement. The pool is wide on purpose —
 * every branch with its gate opened — so that limit sits far below what the product reaches.
 */
import { AppError } from "../../../agent/lib/app-error.js";

export interface GoldenTurn {
  /**
   * Every record that passed its branch gate, before the twelve places were filled. Not all of it
   * is in the pool: it only classifies a relevant pooled record that was not offered.
   */
  gated: readonly string[];
  message: string;
  offered: readonly { memoryRef: string; position: number }[];
  /** `branches`: which branches reached the record with their gates opened; empty when none did. */
  pool: readonly { branches: readonly string[]; memoryRef: string }[];
  /** What the show journal held for this turn: shown to the model, and named by it as used. */
  production: { shown: readonly string[]; used: readonly string[] } | null;
  query: string;
  turnId: string;
}

export interface GoldenLabels {
  relevant: ReadonlyMap<string, boolean>;
  turnId: string;
}

/** Records the judge found a turn needed although no branch put them into its pool. */
export type NeededOutsidePool = ReadonlyMap<string, ReadonlySet<string>>;

export interface GoldenScore {
  /**
   * Turns that needed nothing at all — nothing relevant in the pool and nothing noted outside it:
   * the selection should have stayed empty.
   */
  abstention: {
    emptyWhenNothingRelevant: number | null;
    meanOfferedWhenNothingRelevant: number | null;
    turns: number;
  };
  answerableTurns: number;
  /** Share of answerable turns where at least one relevant record was offered. */
  hitRate: number | null;
  /** Over answerable turns: 1 / place of the first relevant record offered, 0 when none was. */
  meanReciprocalRank: number | null;
  /**
   * Relevant records not offered: a branch reached them and its gate cut them, they passed a gate
   * and lost the twelve places, or no branch reached them at all — production showed them, and
   * the replay found them in none of its branches.
   */
  missedRelevant: { cutByGate: number; notReachedInReplay: number; outranked: number };
  /**
   * Needed records the pool never reached, and recall counted against them too. Pooled recall
   * cannot see these.
   */
  neededOutsidePool: {
    /** Hits over every turn that needed memory, those whose needs all lay outside the pool included. */
    hitRateIncludingOutside: number | null;
    /** Per turn, like `recallInPool`, over the same turns as the hit rate beside it. */
    recallIncludingOutside: number | null;
    records: number;
    turnsWithOnlyOutside: number;
  };
  /** Share of offered records that were relevant: per turn then averaged, and over all records. */
  precisionAtOffered: { macro: number | null; micro: number | null };
  recallInPool: number | null;
  /** The model's own usage line against the labels, on turns the show journal still held. */
  selfReport: {
    relevantShown: number;
    relevantShownUsed: number;
    turns: number;
    used: number;
    usedLabelledRelevant: number;
  };
  turns: number;
}

const mean = (values: readonly number[]) =>
  values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;

function inputError(code: string, message: string): AppError {
  return new AppError(code, `${message}. Проверьте, что pools.jsonl, labels.jsonl и outside-pool.jsonl из одного прогона`);
}

/** Labels and outside notes that name no pooled turn or record were made for another set. */
function requireConsistentInputs(
  turns: readonly GoldenTurn[],
  labelSets: readonly GoldenLabels[],
  outside: NeededOutsidePool,
): void {
  const pools = new Map<string, Set<string>>();
  for (const turn of turns) {
    if (pools.has(turn.turnId)) throw inputError("AGENT_MEMORY_GOLDEN_POOLS_INVALID", `Ход ${turn.turnId} встречается в пулах дважды`);
    if (new Set(turn.offered.map((item) => item.memoryRef)).size !== turn.offered.length) {
      throw inputError("AGENT_MEMORY_GOLDEN_POOLS_INVALID", `В выдаче хода ${turn.turnId} одна запись стоит дважды`);
    }
    pools.set(turn.turnId, new Set(turn.pool.map((record) => record.memoryRef)));
  }
  for (const { relevant, turnId } of labelSets) {
    const pool = pools.get(turnId);
    const stray = [...relevant.keys()].find((memoryRef) => !pool?.has(memoryRef));
    if (stray !== undefined) {
      throw inputError("AGENT_MEMORY_GOLDEN_LABEL_UNKNOWN", `Метка ${turnId} / ${stray} не относится ни к одной записи пулов`);
    }
  }
  for (const [turnId, memoryRefs] of outside) {
    const pool = pools.get(turnId);
    if (pool === undefined) throw inputError("AGENT_MEMORY_GOLDEN_OUTSIDE_UNKNOWN_TURN", `Хода ${turnId} из outside-pool.jsonl нет в пулах`);
    const pooled = [...memoryRefs].find((memoryRef) => pool.has(memoryRef));
    if (pooled !== undefined) {
      throw inputError("AGENT_MEMORY_GOLDEN_OUTSIDE_IN_POOL", `Запись ${pooled} хода ${turnId} отмечена вне пула, но в пуле она есть: разметьте её в labels.jsonl`);
    }
  }
}

function requireLabels(turn: GoldenTurn, labels: ReadonlyMap<string, boolean> | undefined): ReadonlyMap<string, boolean> {
  const missing = turn.pool.filter((record) => labels?.get(record.memoryRef) === undefined);
  if (missing.length === 0) return labels!;
  throw new AppError(
    "AGENT_MEMORY_GOLDEN_LABEL_MISSING",
    `У хода ${turn.turnId} не размечены ${missing.length} записей пула. Разметьте весь пул: неразмеченная запись не считается нерелевантной`,
  );
}

export function scoreGoldenSet(
  turns: readonly GoldenTurn[],
  labelSets: readonly GoldenLabels[],
  outside: NeededOutsidePool = new Map(),
): GoldenScore {
  requireConsistentInputs(turns, labelSets, outside);
  const labelsByTurn = new Map(labelSets.map((one) => [one.turnId, one.relevant]));
  const precisions: number[] = [];
  const recalls: number[] = [];
  const recallsIncludingOutside: number[] = [];
  const reciprocalRanks: number[] = [];
  const unanswerableOffered: number[] = [];
  const missedRelevant = { cutByGate: 0, notReachedInReplay: 0, outranked: 0 };
  const selfReport = { relevantShown: 0, relevantShownUsed: 0, turns: 0, used: 0, usedLabelledRelevant: 0 };
  let offeredTotal = 0;
  let offeredRelevantTotal = 0;
  let hits = 0;
  let outsideRecords = 0;
  let turnsWithOnlyOutside = 0;

  for (const turn of turns) {
    const labels = requireLabels(turn, labelsByTurn.get(turn.turnId));
    const isRelevant = (memoryRef: string) => labels.get(memoryRef) === true;
    const relevant = turn.pool.filter((record) => isRelevant(record.memoryRef)).map((record) => record.memoryRef);
    const offeredRelevant = turn.offered.filter((item) => isRelevant(item.memoryRef));

    offeredTotal += turn.offered.length;
    offeredRelevantTotal += offeredRelevant.length;
    const neededElsewhere = outside.get(turn.turnId)?.size ?? 0;
    outsideRecords += neededElsewhere;
    if (relevant.length === 0 && neededElsewhere > 0) turnsWithOnlyOutside += 1;
    if (relevant.length + neededElsewhere > 0) {
      recallsIncludingOutside.push(offeredRelevant.length / (relevant.length + neededElsewhere));
    }
    if (turn.offered.length > 0) precisions.push(offeredRelevant.length / turn.offered.length);

    if (relevant.length === 0) {
      // A turn whose needs all lay outside the pool did need memory; it is a miss, not a turn
      // where staying silent was the right answer.
      if (neededElsewhere === 0) unanswerableOffered.push(turn.offered.length);
    } else {
      recalls.push(offeredRelevant.length / relevant.length);
      const first = Math.min(...offeredRelevant.map((item) => item.position));
      reciprocalRanks.push(offeredRelevant.length === 0 ? 0 : 1 / first);
      if (offeredRelevant.length > 0) hits += 1;
      const offered = new Set(turn.offered.map((item) => item.memoryRef));
      const gated = new Set(turn.gated);
      const reached = new Set(turn.pool.filter((record) => record.branches.length > 0).map((record) => record.memoryRef));
      for (const memoryRef of relevant) {
        if (offered.has(memoryRef)) continue;
        if (gated.has(memoryRef)) missedRelevant.outranked += 1;
        else if (reached.has(memoryRef)) missedRelevant.cutByGate += 1;
        else missedRelevant.notReachedInReplay += 1;
      }
    }

    if (turn.production !== null) {
      selfReport.turns += 1;
      const used = new Set(turn.production.used);
      selfReport.used += used.size;
      selfReport.usedLabelledRelevant += [...used].filter(isRelevant).length;
      const relevantShown = turn.production.shown.filter(isRelevant);
      selfReport.relevantShown += relevantShown.length;
      selfReport.relevantShownUsed += relevantShown.filter((memoryRef) => used.has(memoryRef)).length;
    }
  }

  return {
    abstention: {
      emptyWhenNothingRelevant: mean(unanswerableOffered.map((count) => (count === 0 ? 1 : 0))),
      meanOfferedWhenNothingRelevant: mean(unanswerableOffered),
      turns: unanswerableOffered.length,
    },
    answerableTurns: recalls.length,
    hitRate: recalls.length === 0 ? null : hits / recalls.length,
    meanReciprocalRank: mean(reciprocalRanks),
    missedRelevant,
    neededOutsidePool: {
      hitRateIncludingOutside: recalls.length + turnsWithOnlyOutside === 0
        ? null
        : hits / (recalls.length + turnsWithOnlyOutside),
      recallIncludingOutside: mean(recallsIncludingOutside),
      records: outsideRecords,
      turnsWithOnlyOutside,
    },
    precisionAtOffered: {
      macro: mean(precisions),
      micro: offeredTotal === 0 ? null : offeredRelevantTotal / offeredTotal,
    },
    recallInPool: mean(recalls),
    selfReport,
    turns: turns.length,
  };
}
