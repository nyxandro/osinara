/**
 * The automatic memory selection: what a turn puts in front of the model before it answers.
 *
 * Exports:
 * - `embedQueryOrDegrade`: the query vector, or none when the embedding service is unreachable.
 * - `SILENT_SELECTION_DIAGNOSTICS`: the branch numbers of a selection that did not search.
 * - `SelectedMemory` / `AutomaticMemorySelection`: one selected record and the whole selection.
 * - `selectMemoriesAutomatically`: small talk, the hybrid search and the date a question names.
 *
 * One function for the turn, the synthetic evaluations and the real-memory golden set, so the
 * numbers are measured on the selection people actually get and not on a part of it.
 */
import { currentTimeRepository } from "./current-time-repository.js";
import { localDate, memoryDateWindow, type MemoryDateWindow } from "./memory-date-question.js";
import { embedMemoryQueryChunks } from "./memory-embedding-client.js";
import { memoryEventWindowRepository } from "./memory-event-window-repository.js";
import { memoryFailureCode } from "./memory-context-failure.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { MEMORY_RETRIEVAL_LIMIT } from "./memory-config.js";
import type { ReferencedMemoryItem } from "./memory-record.js";
import {
  memoryRetrievalRepository,
  type MemoryConflictGroup,
} from "./memory-retrieval-repository.js";
import type {
  MemoryRetrievalBranchDiagnostics,
  MemoryRetrievalBranchEvidence,
} from "./memory-retrieval-ranking.js";
import type { MemorySelectionWindow } from "./memory-show-journal.js";
import { isSmallTalkMessage } from "./memory-small-talk.js";
import type { ModelMemoryEvidence } from "./model-memory.js";
import { GROUP_REMINDER_TIMEZONE } from "./reminders/reminder-config.js";

/** Branch numbers of a selection that stayed silent without searching: nothing was looked at. */
export const SILENT_SELECTION_DIAGNOSTICS: MemoryRetrievalBranchDiagnostics = {
  candidateLimitHit: false,
  recentlyShown: 0,
  russianMatched: 0,
  russianQualified: 0,
  russianTopRank: null,
  semanticMatched: 0,
  semanticQualified: 0,
  semanticTopSimilarity: null,
  simpleMatched: 0,
  simpleQualified: 0,
  simpleTopRank: null,
};

const NO_BRANCH_EVIDENCE: MemoryRetrievalBranchEvidence = {
  russianMorphologyRank: null,
  semanticSimilarity: null,
  simpleLexicalRank: null,
};

export interface SelectedMemory {
  /** How the search branches found it; every field null for a record only its date brought. */
  evidence: MemoryRetrievalBranchEvidence;
  memory: ReferencedMemoryItem;
  /** The fused rank, null for a record only its date brought. */
  score: number | null;
  sourceEvidence?: ModelMemoryEvidence;
}

export interface AutomaticMemorySelection {
  /** True when the message asked memory nothing and no search ran. */
  abstained: boolean;
  claimIdsByConflictRef: ReadonlyMap<string, readonly string[]>;
  conflicts: MemoryConflictGroup[];
  /** The day or period the question named, and how many records carried an event date in it. */
  dateWindow: (MemoryDateWindow & { records: number }) | null;
  diagnostics: MemoryRetrievalBranchDiagnostics;
  /** The query vector by pieces; empty when the service was unreachable or no search ran. */
  embeddings: readonly (readonly number[])[];
  relatedClaimIds: string[];
  selected: SelectedMemory[];
  semanticBranchAvailable: boolean;
}

/**
 * The query vector, or none. One unreachable service used to cost the whole turn its memory: the
 * vector was taken before the database was touched, and a failure there became «память недоступна»
 * — although two of the three branches search text in PostgreSQL and would have found the exact
 * names, numbers and file names the person asked about.
 *
 * There is no retry. The service is already unwell, and a second wait would be paid by the person
 * at exactly the wrong moment; the failure is written down once and the search goes on without it.
 */
export async function embedQueryOrDegrade(prepared: string): Promise<readonly (readonly number[])[]> {
  try {
    return await embedMemoryQueryChunks(prepared);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_MEMORY_SEMANTIC_BRANCH_UNAVAILABLE",
      causeCode: memoryFailureCode(error) ?? "UNCLASSIFIED_EMBEDDING_ERROR",
      queryCharacters: prepared.length,
    }));
    return [];
  }
}

/** Whose calendar «вчера» is read on: the person's own, the group's in a group, UTC otherwise. */
async function questionTimezone(auth: MemoryAuthorization): Promise<string | null> {
  if (auth.userId !== null) return currentTimeRepository.findUserTimezone(auth.userId, auth.familyId);
  return auth.groupId === null ? null : GROUP_REMINDER_TIMEZONE;
}

/**
 * Records of the named period come first when the search found them too — the day and the topic
 * both — then the rest of the period, newest event first, then what the search found outside it.
 * A question about a day is answered by that day; the search fills only what the day left free.
 */
function mergeDateWindow(
  searched: readonly SelectedMemory[],
  dated: readonly ReferencedMemoryItem[],
  limit: number,
): SelectedMemory[] {
  const datedIds = new Set(dated.map((item) => item.id));
  const searchedIds = new Set(searched.map((selected) => selected.memory.id));
  return [
    ...searched.filter((selected) => datedIds.has(selected.memory.id)),
    ...dated.filter((item) => !searchedIds.has(item.id))
      .map((item): SelectedMemory => ({ evidence: NO_BRANCH_EVIDENCE, memory: item, score: null })),
    ...searched.filter((selected) => !datedIds.has(selected.memory.id)),
  ].slice(0, limit);
}

export async function selectMemoriesAutomatically(
  auth: MemoryAuthorization,
  /** The text after `prepareMemoryQuery`. */
  prepared: string,
  options: { limit?: number; now: Date; window: MemorySelectionWindow | null },
): Promise<AutomaticMemorySelection> {
  if (isSmallTalkMessage(prepared)) {
    return {
      abstained: true, claimIdsByConflictRef: new Map(), conflicts: [], dateWindow: null,
      diagnostics: SILENT_SELECTION_DIAGNOSTICS, embeddings: [], relatedClaimIds: [], selected: [],
      semanticBranchAvailable: true,
    };
  }
  const limit = options.limit ?? MEMORY_RETRIEVAL_LIMIT;
  const embeddings = await embedQueryOrDegrade(prepared);
  const retrieval = await memoryRetrievalRepository.searchWithConflictClosure(
    auth, prepared, embeddings, limit, options.window,
  );
  const searched = retrieval.results.map((result): SelectedMemory => ({
    evidence: result.evidence,
    memory: result.memory,
    score: result.score,
    ...(result.sourceEvidence === undefined ? {} : { sourceEvidence: result.sourceEvidence }),
  }));
  // Whether a date is named does not depend on the timezone, only which days it names does: the
  // person's settings are read only for a question that names one.
  let dateWindow: AutomaticMemorySelection["dateWindow"] = null;
  let selected = searched;
  if (memoryDateWindow(prepared, localDate(options.now, null)) !== null) {
    const timezone = await questionTimezone(auth);
    const window = memoryDateWindow(prepared, localDate(options.now, timezone))!;
    const dated = await memoryEventWindowRepository.search(auth, { from: window.from, timezone, to: window.to });
    dateWindow = { ...window, records: dated.length };
    selected = mergeDateWindow(searched, dated, limit);
  }
  return {
    abstained: false,
    claimIdsByConflictRef: retrieval.claimIdsByConflictRef,
    conflicts: retrieval.conflicts,
    dateWindow,
    diagnostics: retrieval.diagnostics,
    embeddings,
    // What the profile may read beside the block: exactly the records offered, conflicts included.
    relatedClaimIds: [...new Set([
      ...selected.map((one) => one.memory.id),
      ...[...retrieval.claimIdsByConflictRef.values()].flat(),
    ])],
    selected,
    semanticBranchAvailable: embeddings.length > 0,
  };
}
