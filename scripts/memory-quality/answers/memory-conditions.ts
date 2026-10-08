/**
 * The memory one turn's request carries under each compared condition.
 *
 * Exports:
 * - `ANSWER_CONDITIONS` / `AnswerCondition`:
 *   - `no_selection`: no automatic selection at all; the model has only `search_memories`, where
 *     the turn's surface offered it.
 *   - `selection`: the product's automatic selection, run on the copy rewound to the turn.
 *   - `ideal_selection`: exactly the records the golden set marks as needed, nothing else.
 * - `MemoryBlock` / `selectionBlock` / `idealSelectionBlock`: the block and the refs it shows.
 *
 * Both blocks go through the product's formatter, payload markers and size budget, and the ideal
 * one reads its records through the product's authorized listing: the records are shown the same
 * way in both. The profile view is left out of both alike: production's memory block, which held
 * it, is the one block every condition replaces (`turn-prompt.ts`).
 *
 * One difference is deliberate: the selection carries the thread briefs production's selection
 * would activate, and the ideal block carries none — it is the needed records and nothing else.
 * Threads are not rewound with the records, so a brief may hold a title or purpose set after the
 * question.
 *
 * Refused rather than approximated: a selection without its meaning branch (the embedding service
 * was down — production would have had it).
 */
import { AppError } from "../../../agent/lib/app-error.js";
import { MEMORY_LIST_MAX_LIMIT } from "../../../agent/lib/memory-config.js";
import type { MemoryAuthorization } from "../../../agent/lib/memory-context.js";
import { memoryListRepository } from "../../../agent/lib/memory-list-repository.js";
import {
  formatRetrievedMemoryInstructions,
  retrieveMemoryTurnContext,
} from "../../../agent/lib/memory-retrieval.js";
import type { ModelMemory } from "../../../agent/lib/model-memory.js";
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

function shownRefs(memories: readonly ModelMemory[]): string[] {
  return memories.map((item) => item.memoryRef);
}

function renderMemoryBlock(
  memories: readonly ModelMemory[],
  threads: MemoryThreadContext | undefined,
  semanticBranchAvailable: boolean,
): MemoryBlock {
  const render = (items: readonly ModelMemory[]) =>
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

export async function idealSelectionBlock(auth: MemoryAuthorization, memoryRefs: readonly string[]): Promise<MemoryBlock> {
  const wanted = new Set(memoryRefs);
  const found = new Map<string, ModelMemory>();
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
