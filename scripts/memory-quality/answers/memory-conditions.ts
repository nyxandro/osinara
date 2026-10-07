/**
 * The memory one turn's request carries under each compared condition.
 *
 * Exports:
 * - `ANSWER_CONDITIONS` / `AnswerCondition`:
 *   - `no_selection`: no automatic selection at all; the model has only `search_memories`.
 *   - `selection`: the product's automatic selection, run on the copy rewound to the turn.
 *   - `ideal_selection`: exactly the records the golden set marks as needed, nothing else.
 * - `MemoryBlock` / `selectionBlock` / `idealSelectionBlock`: the block and the refs it shows.
 *
 * Both blocks go through the product's formatter, payload markers and size budget, and the ideal
 * one reads its records through the product's authorized listing: the records are shown the same
 * way in both. The profile view is left out of both alike.
 *
 * One difference is deliberate: the selection carries the thread briefs production's selection
 * would activate, and the ideal block carries none — it is the needed records and nothing else.
 * Threads are not rewound with the records, so a brief may hold a title or purpose set after the
 * question.
 *
 * Refused rather than approximated: a selection without its meaning branch (the embedding service
 * was down — production would have had it), and a needed record in an unresolved conflict, which
 * production shows only as a pair of versions and the listing would show as an undisputed fact.
 */
import { AppError } from "../../../agent/lib/app-error.js";
import { database } from "../../../agent/lib/database.js";
import { MEMORY_LIST_MAX_LIMIT } from "../../../agent/lib/memory-config.js";
import type { MemoryAuthorization } from "../../../agent/lib/memory-context.js";
import { memoryListRepository } from "../../../agent/lib/memory-list-repository.js";
import {
  formatRetrievedMemoryInstructions,
  retrieveMemoryTurnContext,
  type ModelMemoryContextItem,
} from "../../../agent/lib/memory-retrieval.js";
import type { MemoryThreadContext } from "../../../agent/lib/memory-thread-context.js";
import { toModelMemory } from "../../../agent/lib/model-memory.js";
import { applyTurnMemoryBudget } from "../../../agent/lib/prompt/turn-memory-budget.js";
import { formatTurnMemoryContext } from "../../../agent/lib/prompt/turn-memory-context.js";

export const ANSWER_CONDITIONS = ["no_selection", "selection", "ideal_selection"] as const;
export type AnswerCondition = (typeof ANSWER_CONDITIONS)[number];

export interface MemoryBlock {
  block: string;
  shownRefs: string[];
}

function shownRefs(memories: readonly ModelMemoryContextItem[]): string[] {
  return memories.flatMap((item) => "versions" in item ? item.versions.map((version) => version.memoryRef) : [item.memoryRef]);
}

function renderMemoryBlock(
  memories: readonly ModelMemoryContextItem[],
  threads: MemoryThreadContext | undefined,
  semanticBranchAvailable: boolean,
): MemoryBlock {
  const render = (items: readonly ModelMemoryContextItem[]) =>
    formatTurnMemoryContext(formatRetrievedMemoryInstructions(items, threads, semanticBranchAvailable));
  const budget = applyTurnMemoryBudget({ memories, render });
  return { block: render(budget.memories), shownRefs: shownRefs(budget.memories) };
}

export async function selectionBlock(auth: MemoryAuthorization, query: string): Promise<MemoryBlock> {
  // No selection window: the show journal of the copy describes production's turns, not these.
  const context = await retrieveMemoryTurnContext(auth, query, [], null);
  if (!context.diagnostics.semanticBranchAvailable) {
    throw new AppError(
      "AGENT_MEMORY_ANSWERS_SEMANTIC_UNAVAILABLE",
      "Подборка памяти собрана без смысловой ветки: сервис векторов недоступен. Поднимите его и продолжите прогон",
    );
  }
  return renderMemoryBlock(context.memories, context.threads, true);
}

async function requireUndisputed(memoryRefs: readonly string[]): Promise<void> {
  const disputed = await database().query<{ memory_ref: string }>(
    `SELECT DISTINCT ref.memory_ref
     FROM claim_conflicts AS conflict
     JOIN memory_item_refs AS ref ON ref.memory_item_id IN (conflict.claim_a_id, conflict.claim_b_id)
     WHERE conflict.resolution = 'unresolved' AND ref.memory_ref = ANY($1::text[])`,
    [[...memoryRefs]],
  );
  if (disputed.rows.length > 0) {
    throw new AppError(
      "AGENT_MEMORY_ANSWERS_NEEDED_RECORD_DISPUTED",
      `Нужные по разметке записи стоят в неразрешённом споре версий (${disputed.rows.map((row) => row.memory_ref).join(", ")}). Идеальная подборка их так не покажет: исключите ход или доработайте харнесс`,
    );
  }
}

export async function idealSelectionBlock(auth: MemoryAuthorization, memoryRefs: readonly string[]): Promise<MemoryBlock> {
  await requireUndisputed(memoryRefs);
  const wanted = new Set(memoryRefs);
  const found = new Map<string, ModelMemoryContextItem>();
  let cursor: string | undefined;
  do {
    const page = await memoryListRepository.list(auth, { cursor, limit: MEMORY_LIST_MAX_LIMIT });
    for (const item of page.items) {
      if (wanted.has(item.memoryRef)) found.set(item.memoryRef, toModelMemory(item, item.sourceEvidence));
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && found.size < wanted.size);
  const missing = memoryRefs.filter((memoryRef) => !found.has(memoryRef));
  if (missing.length > 0) {
    throw new AppError(
      "AGENT_MEMORY_ANSWERS_NEEDED_RECORD_UNAVAILABLE",
      `Нужные по разметке записи недоступны ходу в копии (${missing.join(", ")}). Проверьте, что копия восстановлена заново и разметка от этого эталона`,
    );
  }
  return renderMemoryBlock(memoryRefs.map((memoryRef) => found.get(memoryRef)!), undefined, true);
}
